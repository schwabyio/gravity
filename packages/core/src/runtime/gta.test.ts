import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StepSchema, type Collection } from '../model/documents.js'
import type { AssertionResult, RunResult } from '../model/run.js'
import { runRequest } from '../run/runRequest.js'
import { VariableScope } from '../vars/scope.js'
import { checkScriptSyntax, runScript } from './sandbox.js'
import { uuidv7, zoneFor } from './gta.js'

const BODY = {
  string: { value: 'r13FS' },
  boolean: { value: true },
  number: { value: 12345 },
  null: { value: null },
  epoch: { date: Date.now() },
  when: new Date().toISOString(),
  score: 101,
  roles: ['viewer', 'admin'],
  empty: [],
  account: [
    { id: { value: 'b' }, description: 'Savings', balance: 10 },
    { id: { value: 'a' }, description: 'Checking', balance: 20 }
  ]
}

let server: http.Server
let origin: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-request-id': 'abc-123' })
    res.end(JSON.stringify({ ...BODY, url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

const run = (tests: string, extra: Record<string, unknown> = {}, collection?: Collection) =>
  runRequest({
    step: StepSchema.parse({ GET: `${origin}/thing`, tests, ...extra }),
    ...(collection ? { collection } : {}),
    scope: new VariableScope()
  })

const named = (result: RunResult, fragment: string): AssertionResult => {
  const found = result.assertions.find((a) => a.name.includes(fragment))
  if (!found)
    throw new Error(
      `No assertion named like "${fragment}" in: ${result.assertions.map((a) => a.name).join(' | ')}`
    )
  return found
}

const statuses = (result: RunResult) => result.assertions.map((a) => a.status)

describe('xtest functions on gta, without the boilerplate', () => {
  it('checks the status code by value, pattern and negation, and captures it', async () => {
    const result = await run(`
      gta.expectResponseStatusCodeToBe(200)
      gta.expectResponseStatusCodeToBe(/^2/)
      gta.expectResponseStatusCodeToBe(404, 'notThisExpectedValue')
      gta.expectResponseStatusCodeToBe(/^4/, 'notThisExpectedValue')
      gta.expectResponseStatusCodeToBe('lastStatus', 'setAsCollectionVariable')
      gta.test('captured', () => assert.equal(gta.get('lastStatus'), 200))
    `)
    expect(result.error).toBeNull()
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
  })

  it('checks headers every way xtest could', async () => {
    const result = await run(`
      gta.expectResponseToHaveHeader('X-Request-Id')
      gta.expectResponseToHaveHeader('X-Debug', null, 'notThisExpectedKey')
      gta.expectResponseToHaveHeader('x-request-id', 'abc-123')
      gta.expectResponseToHaveHeader('x-request-id', 'nope', 'notThisExpectedValue')
      gta.expectResponseToHaveHeader('Content-Type', /^APPLICATION\\/json/i)
      gta.expectResponseToHaveHeader('Content-Type', /xml/, 'notThisExpectedValue')
      gta.expectResponseToHaveHeader('X-Request-Id', 'requestId', 'setAsCollectionVariable')
    `)
    expect(statuses(result)).toEqual(Array(7).fill('pass'))
    expect(named(result, 'Header X-Request-Id →').path).toBe('X-Request-Id')
  })

  it('reproduces the screenshot: values the property must not have', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('string.value', 'XXXX', 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('boolean.value', false, 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('number.value', '12345', 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('null.value', undefined, 'notThisExpectedValue')
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(result.assertions[2]).toMatchObject({ path: 'number.value', actual: '12345' })
  })

  it('checks body properties with every specialHandling', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('string.value')
      gta.expectResponseBodyToHaveProperty('string.missing', null, 'notThisExpectedKey')
      gta.expectResponseBodyToHaveProperty('number.value', 12345)
      gta.expectResponseBodyToHaveProperty('string.value', /^r13/)
      gta.expectResponseBodyToHaveProperty('string.value', /^x/, 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('epoch.date', 0, 'dateAsEpoch')
      gta.expectResponseBodyToHaveProperty('when', new Date().toISOString(), 'dateWithin5Sec')
      gta.expectResponseBodyToHaveProperty('score', 100, 'integerWithin1')
      gta.expectResponseBodyToHaveProperty('roles', null, 'isArray')
      gta.expectResponseBodyToHaveProperty('empty', null, 'isArrayAndEmpty')
      gta.expectResponseBodyToHaveProperty('roles', null, 'isArrayAndNotEmpty')
      gta.expectResponseBodyToHaveProperty('roles', 2, 'isArrayAndHasLength')
      gta.expectResponseBodyToHaveProperty('string.value', 'token', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('string.value', 'envToken', 'setAsEnvironmentVariable')
    `)
    expect(result.assertions.filter((a) => a.status === 'fail')).toEqual([])
    expect(result.assertions).toHaveLength(14)
  })

  it('reports a wrong value with expected and actual', async () => {
    const result = await run(`gta.expectResponseBodyToHaveProperty('number.value', '12345')`)
    expect(result.assertions[0]).toMatchObject({
      status: 'fail',
      path: 'number.value',
      message: 'Expected "12345" (a string), got 12345 (a number)'
    })
    expect(result.status).toBe('fail')
  })

  it('matches unordered arrays from simple lists and xtest validation lists', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('roles', ['admin', 'viewer'])
      gta.expectResponseBodyToHaveUnorderedArray('account', [
        { pathToProperty: 'id.value', expectedValue: 'a' },
        { pathToProperty: 'description', expectedValue: 'Checking' },
        { pathToProperty: 'balance', expectedValue: 19, specialHandling: 'integerWithin1' },
        { pathToProperty: 'nickname', expectedValue: null, specialHandling: 'notThisExpectedKey' },
        { pathToProperty: 'id.value', expectedValue: 'checkingId', specialHandling: 'setAsCollectionVariable' }
      ])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', ['owner'])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [
        { pathToProperty: 'description', compareValue: 'Brokerage' }
      ])
      gta.test('captured from the matched item', () => assert.equal(gta.get('checkingId'), 'a'))
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass'])
  })

  it('sorts before later checks, and reports the sort for display', async () => {
    const result = await run(`
      gta.sortResponseBodyArrays('id.value')
      gta.expectResponseBodyToHaveProperty('account.0.description', 'Checking')
    `)
    expect(result.assertions[0]?.status).toBe('pass')
    expect(result.sortedBy).toEqual(['id.value'])
  })

  it('strict validation counts the collection’s tests and the step’s together', async () => {
    const collection: Collection = {
      steps: [],
      tests: `gta.expectResponseBodyToHaveProperty('boolean.value', true)`
    }
    const result = await run(
      `
      gta.useStrictValidation(true)
      gta.ignoreResponseBodyProperty('url')
      gta.ignoreResponseBodyArrayObjectProperty('account', 'balance')
      gta.expectResponseBodyToHaveProperty('string.value', 'r13FS')
    `,
      {},
      collection
    )
    const strict = result.assertions.find((a) => a.target === 'strict')!
    expect(strict.status).toBe('fail')
    // Neither script's properties are left over.
    expect(strict.unasserted).not.toContain('boolean.value')
    expect(strict.unasserted).not.toContain('string.value')
    expect(strict.unasserted).not.toContain('url')
    expect(strict.unasserted).not.toContain('account[0].balance')
    expect(strict.unasserted).toContain('number.value')
  })

  it('turns a misused specialHandling into a failed check and carries on', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('score', 1, 'integerWithinTwo')
      gta.expectResponseStatusCodeToBe(200)
    `)
    expect(result.error).toBeNull()
    expect(result.assertions[0]).toMatchObject({
      status: 'fail',
      message: expect.stringMatching(/Unknown specialHandling/)
    })
    expect(result.assertions[1]?.status).toBe('pass')
  })

  it('formats dates with xtest zone letters', async () => {
    expect(zoneFor('U')).toBe('Etc/GMT+8')
    expect(zoneFor('A')).toBe('Etc/GMT-1')
    expect(zoneFor('Z')).toBe('UTC')
    expect(zoneFor('America/New_York')).toBe('America/New_York')
    const result = await run(`
      gta.test('date', () => assert.match(gta.date('%Y-%m-%d', 0, 'Z'), /^\\d{4}-\\d{2}-\\d{2}$/))
    `)
    expect(result.assertions[0]?.status).toBe('pass')
  })
})

describe('any JavaScript alongside', () => {
  it('runs named checks, sync and async, awaited or not', async () => {
    const result = await run(`
      const ids = res.body.account.map((a) => a.id.value)
      gta.test('ids are unique', () => assert.equal(new Set(ids).size, ids.length))
      gta.test('fails with the assertion message', () => assert.equal(res.status, 201))
      gta.test('async', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        assert.equal(res.header('X-Request-Id'), 'abc-123')
      })
    `)
    expect(result.assertions.map((a) => [a.name, a.status])).toEqual([
      ['ids are unique', 'pass'],
      ['fails with the assertion message', 'fail'],
      ['async', 'pass']
    ])
    expect(result.assertions[1]?.message).toMatch(/200/)
    expect(result.assertions[0]?.target).toBe('custom')
  })

  it('captures console output', async () => {
    const result = await run(`console.log('status', res.status, { n: 1 }); console.warn('careful')`)
    expect(result.logs).toEqual([
      { level: 'log', phase: 'tests', message: 'status 200 { n: 1 }' },
      { level: 'warn', phase: 'tests', message: 'careful' }
    ])
  })

  it('reports a thrown error with its line, keeping the checks before it', async () => {
    const result = await run(`gta.expectResponseStatusCodeToBe(200)\n\nnotDefined.call()`)
    expect(result.status).toBe('error')
    expect(result.error).toMatchObject({
      phase: 'tests',
      line: 3,
      message: 'ReferenceError: notDefined is not defined'
    })
    expect(result.assertions[0]?.status).toBe('pass')
  })

  it('reports a syntax error with its line', async () => {
    const result = await run(`const a = 1\nconst = 2`)
    expect(result.error).toMatchObject({ phase: 'tests', line: 2 })
    expect(result.error?.message).toMatch(/^SyntaxError/)
  })

  it('reaches nothing outside the sandbox', async () => {
    const result = await run(`
      gta.test('no require', () => assert.equal(typeof require, 'undefined'))
      gta.test('no process', () => assert.equal(typeof process, 'undefined'))
      gta.test('no fetch', () => assert.equal(typeof fetch, 'undefined'))
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass'])
  })

  it('stops a script that never yields', async () => {
    const error = await runScript('while (true) {}', {
      phase: 'tests',
      filename: 'tests',
      globals: {},
      logs: [],
      timeoutMs: 100
    })
    expect(error).toMatchObject({ code: 'SCRIPT_TIMEOUT' })
  })
})

describe('before.script', () => {
  it('sets variables the request then uses, collection first', async () => {
    const collection: Collection = {
      steps: [],
      before: { script: `gta.set('segment', 'from-collection')` }
    }
    const result = await runRequest({
      step: StepSchema.parse({
        GET: `${origin}/{{segment}}/{{stamp}}`,
        before: { script: `gta.set('stamp', gta.get('segment').length)` }
      }),
      collection,
      scope: new VariableScope()
    })
    expect(result.request.url).toBe(`${origin}/from-collection/15`)
  })

  it('refuses response checks, and never sends the request', async () => {
    const result = await runRequest({
      step: StepSchema.parse({
        GET: `${origin}/x`,
        before: { script: `console.log('before'); gta.expectResponseStatusCodeToBe(200)` }
      }),
      scope: new VariableScope()
    })
    expect(result.response).toBeNull()
    expect(result.error).toMatchObject({ phase: 'pre-request', line: 1 })
    expect(result.error?.message).toMatch(/belongs in tests/)
    expect(result.logs?.[0]).toMatchObject({ phase: 'pre-request', message: 'before' })
  })
})

describe('collection tests', () => {
  it('run for every step, before the step’s own', async () => {
    const collection: Collection = { steps: [], tests: `gta.expectResponseStatusCodeToBe(200)` }
    const result = await run(`gta.expectResponseToHaveHeader('X-Request-Id')`, {}, collection)
    expect(result.assertions.map((a) => a.target)).toEqual(['status', 'header'])
  })
})

describe('the script’s own realm', () => {
  it('compares response data with literals by strict deep equality', async () => {
    const result = await run(`
      gta.test('roles', () => assert.deepEqual(res.body.roles, ['viewer', 'admin']))
      gta.test('array', () => assert.ok(res.body.roles instanceof Array))
    `)
    expect(statuses(result)).toEqual(['pass', 'pass'])
  })
})

describe('checkScriptSyntax', () => {
  it('passes valid code, top-level await included', () => {
    expect(checkScriptSyntax('const a = 1\ngta.test("x", () => a)')).toBeNull()
    expect(checkScriptSyntax('await Promise.resolve(1)\nconst b = 2')).toBeNull()
  })

  it('points at the offending token', () => {
    expect(checkScriptSyntax('const a = 1\nconst = 2')).toEqual({
      line: 2,
      column: 7,
      length: 1,
      message: "SyntaxError: Unexpected token '='"
    })
    expect(checkScriptSyntax('x = 1\n}\ny')).toMatchObject({ line: 2, column: 1 })
  })

  it('puts an unclosed bracket at the end of the script', () => {
    expect(checkScriptSyntax('if (a) {\n  b()')).toMatchObject({
      line: 2,
      column: 6,
      message: 'SyntaxError: Unexpected end of input'
    })
  })

  it('finds errors after a top-level await too', () => {
    expect(checkScriptSyntax('await foo()\nconst = 1')).toMatchObject({ line: 2, column: 7 })
  })
})

describe('generated values', () => {
  it('makes v4 and v7 UUIDs and whole numbers in a range', async () => {
    const result = await run(`
      gta.test('uuid', () => assert.match(gta.uuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
      gta.test('uuidv7', () => assert.match(gta.uuidv7(), /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/))
      gta.test('randomInt', () => {
        for (let i = 0; i < 50; i++) {
          const n = gta.randomInt(5, 7)
          assert.ok(Number.isInteger(n) && n >= 5 && n <= 7)
        }
      })
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass'])
  })

  it('puts the time first in a v7 UUID, so they sort by creation', () => {
    const at = Date.UTC(2026, 8, 25, 12)
    const id = uuidv7(at)
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(at)
    expect(uuidv7(at) < uuidv7(at + 1)).toBe(true)
  })
})
