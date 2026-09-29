import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCollection } from '../format/index.js'
import { applyCollectionEdits, editSource } from './collectionEdits.js'

const SOURCE = [
  '# A collection with comments everywhere.',
  'id: checkout',
  'steps:',
  '  # first',
  '  - name: one',
  '    GET: "http://x/one" # trailing',
  '',
  '  # second, with a block',
  '  - name: two',
  '    POST: "http://x/two"',
  '    tests: |',
  '      gta.expectResponseStatusCodeToBe(201)',
  '',
  '  - name: three',
  '    GET: "http://x/three"',
  ''
].join('\n')

/** The text of one step's item, comments included, as it appears in `source`. */
const block = (source: string, name: string): string => {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line.includes(`name: ${name}`))
  let end = start + 1
  while (end < lines.length && lines[end]!.startsWith('    ')) end++
  return lines.slice(start, end).join('\n')
}

const names = (source: string) => parseCollection(source).data.steps.map((s) => s.name)

describe('editSource: step structure', () => {
  it('inserts a step without touching the others', () => {
    const next = editSource(SOURCE, [
      { type: 'insertStep', index: 1, step: { name: 'new', GET: 'http://x/new' } }
    ])
    expect(names(next)).toEqual(['one', 'new', 'two', 'three'])
    for (const name of ['one', 'two', 'three']) expect(block(next, name)).toBe(block(SOURCE, name))
    expect(next).toContain('# A collection with comments everywhere.')
    expect(next).toContain('# trailing')
  })

  it('removes a step, keeping the comments of the rest', () => {
    const next = editSource(SOURCE, [{ type: 'removeStep', index: 0 }])
    expect(names(next)).toEqual(['two', 'three'])
    expect(block(next, 'two')).toBe(block(SOURCE, 'two'))
    expect(next).not.toContain('http://x/one')
  })

  it('moves a step with its own comment and block scalar', () => {
    const next = editSource(SOURCE, [{ type: 'moveStep', from: 1, to: 2 }])
    expect(names(next)).toEqual(['one', 'three', 'two'])
    expect(block(next, 'two')).toBe(block(SOURCE, 'two'))
    expect(next.indexOf('# second, with a block')).toBeGreaterThan(next.indexOf('name: three'))
  })

  it('applies several edits in order, as one result', () => {
    const next = editSource(SOURCE, [
      { type: 'editStep', index: 2, step: { name: 'three', GET: 'http://x/3' } },
      { type: 'moveStep', from: 2, to: 0 },
      { type: 'insertStep', index: 3, step: { name: 'four', DELETE: 'http://x/4' } }
    ])
    expect(names(next)).toEqual(['three', 'one', 'two', 'four'])
    expect(next).toContain('GET: "http://x/3"')
  })

  it('adds a first step to an empty collection as a block list', () => {
    const next = editSource('id: empty\nsteps: []\n', [
      { type: 'insertStep', index: 0, step: { name: 'first', GET: 'http://x' } }
    ])
    expect(next).toBe('id: empty\nsteps:\n  - name: first\n    GET: http://x\n')
  })

  it('rejects an edit that would make the file invalid', () => {
    expect(() =>
      editSource(SOURCE, [{ type: 'insertStep', index: 0, step: { name: 'no method' } }])
    ).toThrow(/one method key/)
    expect(() => editSource(SOURCE, [{ type: 'removeStep', index: 9 }])).toThrow(/no step/)
  })
})

describe('applyCollectionEdits', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gta-edits-'))
    file = path.join(dir, 'c.yml')
    fs.writeFileSync(file, SOURCE)
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('writes the batch once, atomically, and reports the new text', async () => {
    const outcome = await applyCollectionEdits(file, SOURCE, [{ type: 'removeStep', index: 2 }])
    expect(outcome).toMatchObject({ ok: true, wrote: true })
    expect(fs.readFileSync(file, 'utf8')).toBe(outcome.source)
    // No temporary file is left behind.
    expect(fs.readdirSync(dir)).toEqual(['c.yml'])
  })

  it('writes nothing when nothing changed', async () => {
    const before = fs.statSync(file).mtimeMs
    const step = parseCollection(SOURCE).data.steps[0]!
    const outcome = await applyCollectionEdits(file, SOURCE, [{ type: 'editStep', index: 0, step }])
    expect(outcome).toEqual({ ok: true, source: SOURCE, wrote: false })
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('refuses to write over a file that changed since the edit began', async () => {
    const theirs = SOURCE.replace('http://x/one', 'http://pulled/one')
    fs.writeFileSync(file, theirs)
    const outcome = await applyCollectionEdits(file, SOURCE, [{ type: 'removeStep', index: 0 }])
    expect(outcome).toEqual({ ok: false, conflict: true, source: theirs })
    expect(fs.readFileSync(file, 'utf8')).toBe(theirs)
  })

  it('writes an id only when it is the file name', async () => {
    await expect(
      applyCollectionEdits(file, SOURCE, [{ type: 'editCollection', key: 'id', value: 'other' }])
    ).rejects.toThrow('id: must be c, the file name')
    expect(fs.readFileSync(file, 'utf8')).toBe(SOURCE)
    const fixed = await applyCollectionEdits(file, SOURCE, [
      { type: 'editCollection', key: 'id', value: 'c' }
    ])
    expect(fixed.source).toMatch(/^# A collection with comments everywhere\.\nid: c\n/)
  })
})

describe('editSource: changing a step', () => {
  it('changes the method in place, with the name, in one edit', () => {
    const next = editSource(SOURCE, [
      { type: 'editStep', index: 0, step: { name: 'fetch', POST: 'http://x/one' } }
    ])
    expect(next).toContain('  # first\n  - name: fetch\n    POST: "http://x/one" # trailing')
    expect(block(next, 'two')).toBe(block(SOURCE, 'two'))
  })

  it('changes method and URL together on a newly added step', () => {
    const added = editSource(SOURCE, [
      { type: 'insertStep', index: 3, step: { name: 'New step', GET: '' } }
    ])
    const next = editSource(added, [
      { type: 'editStep', index: 3, step: { name: 'Create order', PUT: 'http://x/orders' } }
    ])
    expect(parseCollection(next).data.steps[3]).toEqual({
      name: 'Create order',
      PUT: 'http://x/orders'
    })
  })

  it('still rejects a step left with two methods', () => {
    expect(() =>
      editSource(SOURCE, [
        { type: 'editStep', index: 0, step: { name: 'one', GET: 'http://x', POST: 'http://x' } }
      ])
    ).toThrow(/more than one method/)
  })
})

describe('editSource: collection fields', () => {
  it('adds collection tags after the id, not after the steps', () => {
    const next = editSource(SOURCE, [{ type: 'editCollection', key: 'tags', value: ['smoke'] }])
    expect(
      next.startsWith(
        '# A collection with comments everywhere.\nid: checkout\ntags: [smoke]\nsteps:'
      )
    ).toBe(true)
    for (const name of ['one', 'two', 'three']) expect(block(next, name)).toBe(block(SOURCE, name))
  })

  it('changes and removes them in place', () => {
    const tagged = editSource(SOURCE, [{ type: 'editCollection', key: 'tags', value: ['a'] }])
    const changed = editSource(tagged, [{ type: 'editCollection', key: 'tags', value: ['a', 'b'] }])
    expect(changed).toContain('tags: [a, b]\nsteps:')
    const removed = editSource(changed, [{ type: 'editCollection', key: 'tags', value: undefined }])
    expect(removed).toBe(SOURCE)
  })

  it('writes exclude after the tags, and removes it cleanly', () => {
    const tagged = editSource(SOURCE, [
      { type: 'editCollection', key: 'exclude', value: true },
      { type: 'editCollection', key: 'tags', value: ['smoke'] }
    ])
    expect(tagged).toContain('id: checkout\ntags: [smoke]\nexclude: true\nsteps:')
    const removed = editSource(tagged, [
      { type: 'editCollection', key: 'exclude', value: undefined },
      { type: 'editCollection', key: 'tags', value: undefined }
    ])
    expect(removed).toBe(SOURCE)
  })

  it('refuses a tag with a space in it', () => {
    expect(() =>
      editSource(SOURCE, [{ type: 'editCollection', key: 'tags', value: ['has space'] }])
    ).toThrow(/a tag is letters, digits/)
  })
})

describe('editSource: step tags', () => {
  it('writes a step’s tags on one line, once the collection allows them', () => {
    const next = editSource(SOURCE, [
      { type: 'editCollection', key: 'stepTags', value: true },
      {
        type: 'editStep',
        index: 2,
        step: { name: 'three', GET: 'http://x/three', tags: ['smoke', 'auth'] }
      }
    ])
    expect(next).toContain('id: checkout\nstepTags: true\nsteps:')
    expect(block(next, 'three')).toBe(
      '  - name: three\n    GET: "http://x/three"\n    tags: [smoke, auth]'
    )
  })
})

describe('editSource: settings', () => {
  it('puts a step’s new settings before its tests, where a person would write them', () => {
    const next = editSource(SOURCE, [
      {
        type: 'editStep',
        index: 1,
        step: {
          name: 'two',
          POST: 'http://x/two',
          settings: { timeout: 5000, followRedirects: false },
          tests: 'gta.expectResponseStatusCodeToBe(201)\n'
        }
      }
    ])
    expect(block(next, 'two')).toBe(
      [
        '  - name: two',
        '    POST: "http://x/two"',
        '    settings:',
        '      timeout: 5000',
        '      followRedirects: false',
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(201)'
      ].join('\n')
    )
  })

  it('puts collection settings after the id and before the steps', () => {
    const next = editSource(SOURCE, [
      { type: 'editCollection', key: 'settings', value: { timeout: 10000 } }
    ])
    expect(next).toContain('id: checkout\nsettings:\n  timeout: 10000\nsteps:')
  })

  it('refuses a negative timeout', () => {
    expect(() =>
      editSource(SOURCE, [{ type: 'editCollection', key: 'settings', value: { timeout: -1 } }])
    ).toThrow(/timeout/)
  })
})

describe('editSource: headers', () => {
  const WITH_HEADERS = SOURCE.replace(
    'id: checkout\n',
    [
      'id: checkout',
      'headers:',
      '  Accept: application/json # every step',
      '  # who is calling',
      "  X-Client: 'gta'",
      ''
    ].join('\n')
  )

  it('puts new collection headers after the id and before the steps', () => {
    const next = editSource(SOURCE, [
      { type: 'editCollection', key: 'headers', value: { Accept: 'application/json' } }
    ])
    expect(next).toContain('id: checkout\nheaders:\n  Accept: application/json\nsteps:')
  })

  it('changes one header in place, keeping the others and their comments', () => {
    const next = editSource(WITH_HEADERS, [
      {
        type: 'editCollection',
        key: 'headers',
        value: { Accept: 'text/plain', 'X-Client': 'gta', 'X-Trace': '1' }
      }
    ])
    expect(next).toContain(
      [
        'headers:',
        '  Accept: text/plain # every step',
        '  # who is calling',
        "  X-Client: 'gta'",
        '  X-Trace: "1"',
        'steps:'
      ].join('\n')
    )
    for (const name of ['one', 'two', 'three']) expect(block(next, name)).toBe(block(SOURCE, name))
  })

  it('removes one header, and the key with the last', () => {
    const one = editSource(WITH_HEADERS, [
      { type: 'editCollection', key: 'headers', value: { 'X-Client': 'gta' } }
    ])
    expect(one).toContain("headers:\n  # who is calling\n  X-Client: 'gta'\nsteps:")
    const none = editSource(one, [{ type: 'editCollection', key: 'headers', value: undefined }])
    expect(none).toBe(SOURCE)
  })

  it('edits a step’s header without rewriting its neighbours', () => {
    const source = SOURCE.replace(
      '    GET: "http://x/three"\n',
      "    GET: \"http://x/three\"\n    headers:\n      # keep me\n      A: '1'\n      B: '2'\n"
    )
    const next = editSource(source, [
      {
        type: 'editStep',
        index: 2,
        step: { name: 'three', GET: 'http://x/three', headers: { A: '1', B: '3' } }
      }
    ])
    expect(block(next, 'three')).toBe(
      "  - name: three\n    GET: \"http://x/three\"\n    headers:\n      # keep me\n      A: '1'\n      B: '3'"
    )
  })
})

describe('editSource: variables and scripts', () => {
  it('puts vars, before and tests after the settings, in that order, before the steps', () => {
    const next = editSource(SOURCE, [
      { type: 'editCollection', key: 'tests', value: 'gta.expectResponseStatusCodeToBe(200)\n' },
      { type: 'editCollection', key: 'vars', value: { apiVersion: '2', retries: 3, live: false } },
      { type: 'editCollection', key: 'before', value: { script: "gta.set('id', gta.uuid())\n" } }
    ])
    expect(next).toContain(
      [
        'id: checkout',
        'vars:',
        '  apiVersion: "2"',
        '  retries: 3',
        '  live: false',
        'before:',
        '  script: |',
        "    gta.set('id', gta.uuid())",
        'tests: |',
        '  gta.expectResponseStatusCodeToBe(200)',
        'steps:'
      ].join('\n')
    )
    for (const name of ['one', 'two', 'three']) expect(block(next, name)).toBe(block(SOURCE, name))
  })

  it('writes even one line of code as a block, but leaves code it did not edit alone', () => {
    const source = SOURCE.replace('id: checkout\n', "id: checkout\ntests: 'gta.x()'\n")
    const next = editSource(source, [
      { type: 'editCollection', key: 'before', value: { script: "gta.set('a', 1)" } },
      {
        type: 'editStep',
        index: 0,
        step: { name: 'one', GET: 'http://x/one', tests: 'gta.expectResponseStatusCodeToBe(200)' }
      }
    ])
    expect(next).toContain("before:\n  script: |-\n    gta.set('a', 1)\ntests: 'gta.x()'\n")
    expect(next).toContain('    tests: |-\n      gta.expectResponseStatusCodeToBe(200)')
  })

  it('changes one variable in place, keeping the others’ comments and quotes', () => {
    const source = SOURCE.replace(
      'id: checkout\n',
      "id: checkout\nvars:\n  # the API version\n  apiVersion: '2'\n  retries: 3 # enough\n"
    )
    const next = editSource(source, [
      { type: 'editCollection', key: 'vars', value: { apiVersion: '2', retries: 5 } }
    ])
    expect(next).toContain("vars:\n  # the API version\n  apiVersion: '2'\n  retries: 5 # enough\n")
  })

  it('keeps a variable’s type', () => {
    const next = editSource(SOURCE, [
      { type: 'editCollection', key: 'vars', value: { n: '5', m: 5, empty: null } }
    ])
    expect(next).toContain('vars:\n  n: "5"\n  m: 5\n  empty: null\n')
  })

  it('refuses a variable that is not a plain value', () => {
    expect(() =>
      editSource(SOURCE, [{ type: 'editCollection', key: 'vars', value: { id: { uuid: true } } }])
    ).toThrow(/a variable is a string, number, boolean or null/)
  })
})

describe('step tags need the collection’s permission', () => {
  it('refuses a step tag in a collection without stepTags', () => {
    expect(() =>
      editSource(SOURCE, [
        { type: 'editStep', index: 0, step: { name: 'one', GET: 'http://x/one', tags: ['smoke'] } }
      ])
    ).toThrow(/step tags need stepTags: true/)
  })
})
