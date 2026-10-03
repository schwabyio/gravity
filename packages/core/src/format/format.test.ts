import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyStepEdits,
  createCollection,
  editCollection,
  FormatError,
  parseCollection,
  parseEnvironment,
  serialize
} from './index.js'
import { readRequestLine, stepLabel } from '../model/documents.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.resolve(here, '../../test-fixtures/workspace')
const read = (relativePath: string) => fs.readFileSync(path.join(FIXTURES, relativePath), 'utf8')

const COLLECTIONS = [
  path.join('collections', 'status-codes.yml'),
  path.join('collections', 'checkout', 'sessions.yml')
]

describe('round-trip', () => {
  it.each(COLLECTIONS)('%s survives parse -> serialize byte for byte', (relativePath) => {
    const source = read(relativePath)
    expect(serialize(parseCollection(source, relativePath))).toBe(source)
  })

  it('round-trips an environment file', () => {
    const source = read(path.join('environments', 'demo.yml'))
    expect(serialize(parseEnvironment(source))).toBe(source)
  })
})

describe('collections', () => {
  it('reads the collection-level keys', () => {
    const { data } = parseCollection(read(path.join('collections', 'status-codes.yml')))
    expect(data.id).toBe('status-codes')
    expect(data.docs).toContain('validate response status code')
    expect(data.headers?.['Accept']).toBe('*/*')
    expect(data.settings?.timeout).toBe(30000)
    expect(data.vars?.['apiVersion']).toBe('2')
  })

  it('treats list order as run order, with no seq anywhere', () => {
    const { data } = parseCollection(read(path.join('collections', 'status-codes.yml')))
    expect(data.steps.map((step) => step.name)).toEqual([
      'expectedValue = 200',
      'expectedValue = 204'
    ])
    expect(JSON.stringify(data)).not.toContain('"seq"')
  })

  it('reads each step’s method and url', () => {
    const { data } = parseCollection(read(path.join('collections', 'status-codes.yml')))
    expect(readRequestLine(data.steps[0]!)).toEqual({
      method: 'GET',
      url: '{{baseUrl}}/responseStatusCode200'
    })
  })

  it('reads per-step settings and tags', () => {
    const { data } = parseCollection(read(path.join('collections', 'status-codes.yml')))
    expect(data.steps[1]?.tags).toEqual(['smoke'])
    expect(data.steps[1]?.settings?.maxRedirects).toBe(5)
  })

  it('reads all three header forms on a step', () => {
    const { data } = parseCollection(read(path.join('collections', 'checkout', 'sessions.yml')))
    const headers = data.steps[0]?.headers ?? {}
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Set-Cookie']).toEqual(['a=1', 'b=2'])
    expect(headers['X-Trace']).toEqual({ value: '{{traceId}}', enabled: false })
  })

  it('reads collection-level before.script and tests', () => {
    const { data } = parseCollection(read(path.join('collections', 'checkout', 'sessions.yml')))
    expect(data.before?.script).toContain("gta.set('signature'")
    expect(data.tests).toContain('gta.expectResponseToHaveHeader')
    expect(data.steps[2]?.tests).toContain("gta.test('roles are sorted'")
  })

  it('rejects the retired script key', () => {
    expect(() =>
      parseCollection('script:\n  before: x\nsteps:\n  - GET: "http://x"\n', 'old.yml')
    ).toThrow(FormatError)
  })

  it('reads tests code as written, xtest calls and all', () => {
    const { data } = parseCollection(read(path.join('collections', 'checkout', 'sessions.yml')))
    const tests = data.steps[0]?.tests ?? ''
    expect(tests).toContain("gta.expectResponseBodyToHaveProperty('error.code', 'token_expired')")
    expect(tests).toContain("gta.expectResponseBodyToHaveProperty('error.message', /expired/)")
    expect(tests).toContain("gta.ignoreResponseBodyProperty('error.timestamp')")
    expect(data.steps[1]?.tests).toContain("gta.sortResponseBodyArrays('id')")
  })

  it('rejects a retired before.set, and generators in vars', () => {
    expect(() =>
      parseCollection('steps:\n  - GET: "http://x"\n    before:\n      set:\n        a: 1\n')
    ).toThrow(/before.set is not supported/)
    expect(() => parseCollection('vars:\n  id: { uuid: true }\nsteps: []\n')).toThrow(
      /compute values in before.script/
    )
  })

  it('rejects a retired expect block rather than ignoring its checks', () => {
    expect(() =>
      parseCollection('steps:\n  - GET: "http://x"\n    expect:\n      status: 200\n', 'old.yml')
    ).toThrow(/expect: blocks are not supported/)
  })

  it('names a step by what it does when it has no name', () => {
    const { data } = parseCollection('steps:\n  - GET: "http://x/y"\n')
    expect(stepLabel(data.steps[0]!)).toBe('GET http://x/y')
  })
})

describe('validation', () => {
  it('rejects a step with no method', () => {
    expect(() => parseCollection('steps:\n  - name: x\n', 'a.yml')).toThrow(/one method key/)
  })

  it('takes a step with connection: and no method as one reading that connection', () => {
    const { data } = parseCollection(
      'steps:\n  - GET: "http://x/events"\n    connection: orders\n  - connection: orders\n    settings:\n      untilEvent: order.created\n'
    )
    expect(stepLabel(data.steps[1]!)).toBe('read orders')
    for (const key of [
      'headers:\n      A: b',
      'body:\n      json: "{}"',
      'base: false',
      "forEach: '[1]'"
    ]) {
      expect(() =>
        parseCollection(`steps:\n  - connection: orders\n    ${key}\n`, 'a.yml')
      ).toThrow(/a step that reads a connection sends nothing, so it cannot have/)
    }
  })

  it('rejects a connection on a use step, or beside forEach, and a name with spaces', () => {
    expect(() =>
      parseCollection('steps:\n  - use: login\n    connection: orders\n', 'a.yml')
    ).toThrow(/a use: step runs a request set, so it cannot have connection/)
    expect(() =>
      parseCollection(
        'steps:\n  - GET: "http://x"\n    connection: orders\n    forEach: "[1]"\n',
        'a.yml'
      )
    ).toThrow(/a step opening a connection cannot have it/)
    expect(() =>
      parseCollection('steps:\n  - GET: "http://x"\n    connection: my orders\n', 'a.yml')
    ).toThrow(/a connection name is letters, digits/)
  })

  it('rejects a key a step does not have, rather than ignoring it', () => {
    expect(() =>
      parseCollection('steps:\n  - GET: "http://x"\n    heders:\n      Accept: x\n', 'a.yml')
    ).toThrow(
      'unknown key "heders" on a step; a step holds a method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS) or use and with, and name, headers, body, settings, before, tests, tags, flags, forEach, useTests, base, docs, connection (SPEC.md §2.1)'
    )
    // On a use step too.
    expect(() =>
      parseCollection('steps:\n  - use: login\n    whit: { user: a }\n', 'a.yml')
    ).toThrow(/unknown key "whit" on a step/)
  })

  it('says a method key is written in capitals', () => {
    const lower = () => parseCollection('steps:\n  - get: "http://x"\n', 'a.yml')
    expect(lower).toThrow('get: a method key is written in capitals, GET (SPEC.md §2.1)')
    // Said once, not also as a step with no method.
    expect(lower).not.toThrow(/one method key/)
  })

  it('accepts every key a step may have', () => {
    const { data } = parseCollection(
      [
        'stepTags: true',
        'steps:',
        '  - name: all of them',
        '    GET: "http://x"',
        '    headers: { A: b }',
        '    body: { text: hi }',
        '    settings: { timeout: 1 }',
        '    before: { script: "1" }',
        '    tests: "1"',
        '    tags: [t]',
        '    flags: { f: true }',
        '    base: false',
        '    docs: d',
        '  - use: login',
        '    with: { a: 1 }',
        ''
      ].join('\n')
    )
    expect(data.steps).toHaveLength(2)
  })

  it('rejects a step with two methods', () => {
    expect(() => parseCollection('steps:\n  - GET: "http://x"\n    POST: "http://x"\n')).toThrow(
      /more than one method/
    )
  })

  it('rejects a body declaring two forms', () => {
    expect(() =>
      parseCollection('steps:\n  - POST: "http://x"\n    body:\n      json: "{}"\n      text: hi\n')
    ).toThrow(/exactly one of/)
  })

  it('rejects an unknown collection key rather than dropping it', () => {
    expect(() => parseCollection('stpes: []\nsteps: []\n')).toThrow(FormatError)
  })

  it('accepts a collection with no steps', () => {
    expect(parseCollection('id: empty\nsteps: []\n').data.steps).toEqual([])
  })

  it('names the file in the error', () => {
    expect(() => parseCollection('steps:\n  - name: x\n', 'checkout/broken.yml')).toThrow(
      /checkout\/broken\.yml/
    )
  })

  it('reports malformed YAML', () => {
    expect(() => parseCollection('steps: [unclosed\n', 'bad.yml')).toThrow(FormatError)
  })
})

describe('editing a step', () => {
  it('changes one step and leaves every other line alone', () => {
    const source = read(path.join('collections', 'status-codes.yml'))
    const file = parseCollection(source)
    const next = { ...file.data.steps[0]!, GET: '{{baseUrl}}/changed' }

    const output = serialize(applyStepEdits(file, 0, next))
    const changed = output.split('\n').filter((line, i) => line !== source.split('\n')[i])
    expect(changed).toEqual(['    GET: "{{baseUrl}}/changed"'])
  })

  it('leaves the sibling steps untouched', () => {
    const source = read(path.join('collections', 'status-codes.yml'))
    const file = parseCollection(source)
    const output = serialize(
      applyStepEdits(file, 0, { ...file.data.steps[0]!, GET: 'http://other' })
    )
    expect(output).toContain('{{baseUrl}}/responseStatusCode204')
    expect(output).toContain('tags: [smoke]')
  })

  it('preserves comments through an edit', () => {
    const source = read(path.join('collections', 'status-codes.yml'))
    expect(source).toContain('# Applied to every step')
    const edited = editCollection(parseCollection(source), ['settings', 'timeout'], 1000)
    expect(serialize(edited)).toContain('# Applied to every step')
  })

  it('removes a key the editor cleared', () => {
    const file = parseCollection(read(path.join('collections', 'status-codes.yml')))
    const { tags: _dropped, ...withoutTags } = file.data.steps[1]!
    expect(serialize(applyStepEdits(file, 1, withoutTags))).not.toContain('tags: [smoke]')
  })

  it('is a no-op when nothing changed', () => {
    const source = read(path.join('collections', 'status-codes.yml'))
    const file = parseCollection(source)
    expect(serialize(applyStepEdits(file, 0, file.data.steps[0]!))).toBe(source)
  })

  it('rejects an edit that would break the schema', () => {
    const file = parseCollection(read(path.join('collections', 'status-codes.yml')))
    expect(() => applyStepEdits(file, 0, { ...file.data.steps[0]!, POST: 'http://x' })).toThrow(
      /more than one method/
    )
  })
})

describe('creating a collection', () => {
  it('writes a file that parses back to the same data', () => {
    const created = createCollection({
      id: 'new-collection',
      steps: [{ name: 'first', GET: 'https://example.test/thing' }]
    })
    expect(parseCollection(serialize(created)).data).toEqual(created.data)
  })

  it('round-trips a created file byte for byte', () => {
    const text = serialize(createCollection({ id: 'new', steps: [{ POST: 'https://x.test' }] }))
    expect(serialize(parseCollection(text))).toBe(text)
  })
})
