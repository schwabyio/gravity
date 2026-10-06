import { Buffer } from 'node:buffer'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CheckSession } from '../assert/session.js'
import { UnknownFlagError } from '../flags/flags.js'
import { StepSchema, type Collection } from '../model/documents.js'
import type { AssertionResult, RunResult } from '../model/run.js'
import { runRequest } from '../run/runRequest.js'
import { strftime } from '../vars/generators.js'
import { VariableScope, type VarLayer } from '../vars/scope.js'
import { checkScriptSyntax, runScript } from './sandbox.js'
import {
  GtaUsageError,
  newStepControl,
  preRequestGta,
  responseView,
  SPECIAL_HANDLING,
  testsGta,
  uuidv7,
  xtestMatcher,
  zoneFor
} from './gta.js'

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
  ],
  // Keys only a list of keys, or a quoted key, can reach.
  decodedJwt: {
    payload: { 'https://data.ia.io/ia_acct_uuid': 'acct-1', 'https://data.ia.io/roles': ['admin'] }
  },
  licenses: [
    { licenseKey: 'k1', modules: { '': { params: { edition: 'maker' } } } },
    { licenseKey: 'k2', modules: { '': { params: { edition: 'basic' } } } }
  ],
  byId: { '7': { city: 'Sacramento' } },
  people: [{ name: 'Ada', phone: null }],
  // The same description twice: only the org tells the items apart.
  values: [
    { field: 'tier', value: 'gold', org: 'o1' },
    { field: 'tier', value: 'gold', org: 'o2' }
  ]
}

let server: http.Server
let origin: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0x00, 0xff, 0x10]))
      return
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><body>Hello</body></html>')
      return
    }
    if (req.url === '/queue') {
      // Ties on group, which name breaks, and one job with no group at all.
      const jobs = [
        { group: 2, name: 'b' },
        { group: 1, name: 'c' },
        { name: 'z' },
        { group: 1, name: 'a' }
      ]
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jobs }))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'abc-123',
      'x-tag': ['a=1', 'b=2']
    })
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
    // What was ignored is reported, with where, and never counted as a check.
    expect(result.ignored).toEqual([
      { path: 'url', source: { script: 'step', line: 3 } },
      { path: 'account[].balance', source: { script: 'step', line: 4 } }
    ])
    expect(result.assertions.map((a) => a.name)).not.toContain('ignoreResponseBodyProperty')
    expect(result.assertions).toHaveLength(3)
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

describe('xtestMatcher: a call’s arguments as a matcher', () => {
  it('asks for presence with no value, and equality or a pattern with one', () => {
    expect(xtestMatcher(false, undefined)).toEqual({ present: true })
    expect(xtestMatcher(true, 5)).toEqual({ equals: 5 })
    expect(xtestMatcher(true, undefined)).toEqual({ equals: undefined })
    expect(xtestMatcher(true, /^a/)).toEqual({ matches: /^a/ })
    expect(xtestMatcher(true, 5, null as unknown as string)).toEqual({ equals: 5 })
  })

  it('maps every specialHandling', () => {
    expect(xtestMatcher(true, null, 'notThisExpectedKey')).toEqual({ absent: true })
    expect(xtestMatcher(true, 'a', 'notThisExpectedValue')).toEqual({ not: 'a' })
    expect(xtestMatcher(true, /a/, 'notThisExpectedValue')).toEqual({ notMatches: /a/ })
    expect(xtestMatcher(true, 'v', 'setAsCollectionVariable')).toEqual({ into: 'v' })
    expect(xtestMatcher(true, 'v', 'setAsEnvironmentVariable')).toEqual({ intoEnv: 'v' })
    expect(xtestMatcher(true, 0, 'dateAsEpoch')).toEqual({ equals: 0, dateAsEpoch: true })
    expect(xtestMatcher(true, 'w', 'dateWithin30Sec')).toEqual({
      equals: 'w',
      dateWithinSeconds: 30
    })
    expect(xtestMatcher(true, 100, 'integerWithin2')).toEqual({ equals: 100, within: 2 })
    expect(xtestMatcher(true, null, 'isArray')).toEqual({ isArray: true })
    expect(xtestMatcher(true, null, 'isArrayAndEmpty')).toEqual({ isArray: 'empty' })
    expect(xtestMatcher(true, null, 'isArrayAndNotEmpty')).toEqual({ isArray: 'notEmpty' })
    expect(xtestMatcher(true, 2, 'isArrayAndHasLength')).toEqual({ isArray: true, length: 2 })
    // The list the error message offers holds nothing that is then refused.
    for (const handling of SPECIAL_HANDLING) {
      const value = handling.startsWith('setAs') ? 'v' : handling === 'isArrayAndHasLength' ? 1 : 0
      expect(() => xtestMatcher(true, value, handling.replace('<X>', '3')), handling).not.toThrow()
    }
  })

  it('refuses a length that is not a number, a variable name that is not text, and an unknown string', () => {
    expect(() => xtestMatcher(true, '2', 'isArrayAndHasLength')).toThrow(
      new GtaUsageError('isArrayAndHasLength needs the length as a number, got "2"')
    )
    for (const handling of ['setAsCollectionVariable', 'setAsEnvironmentVariable']) {
      expect(() => xtestMatcher(true, '', handling)).toThrow(/non-empty string, got ""/)
      expect(() => xtestMatcher(true, 5, handling)).toThrow(/non-empty string, got 5/)
    }
    for (const handling of ['integerWithinTwo', 'dateWithinXSec', 'isarray']) {
      expect(() => xtestMatcher(true, 1, handling)).toThrow(
        `Unknown specialHandling "${handling}". Supported: ${SPECIAL_HANDLING.join(', ')}`
      )
    }
  })
})

describe('checks that fail, and say why', () => {
  const outcomes = (result: RunResult) => result.assertions.map((a) => [a.status, a.message])

  it('fails a status code that is not the one expected, comparing as text', async () => {
    const result = await run(`
      gta.expectResponseStatusCodeToBe('200')
      gta.expectResponseStatusCodeToBe(201)
      gta.expectResponseStatusCodeToBe(/^4/)
      gta.expectResponseStatusCodeToBe(200, 'notThisExpectedValue')
      gta.expectResponseStatusCodeToBe('envStatus', 'setAsEnvironmentVariable')
      gta.test('saved', () => assert.equal(gta.get('envStatus'), 200))
    `)
    expect(outcomes(result)).toEqual([
      ['pass', undefined],
      ['fail', 'Expected 201, got 200'],
      ['fail', 'Expected to match /^4/, got "200"'],
      ['fail', 'Must not be 200'],
      ['pass', undefined],
      ['pass', undefined]
    ])
    expect(result.status).toBe('fail')
  })

  it('fails a header that is missing, different, or present when it must not be', async () => {
    const result = await run(`
      gta.expectResponseToHaveHeader('X-Missing')
      gta.expectResponseToHaveHeader('X-Request-Id', 'abc-999')
      gta.expectResponseToHaveHeader('X-Request-Id', /^xyz/)
      gta.expectResponseToHaveHeader('X-Request-Id', null, 'notThisExpectedKey')
      gta.expectResponseToHaveHeader('X-Request-Id', 'abc-123', 'notThisExpectedValue')
      gta.expectResponseToHaveHeader('X-Missing', 'missingId', 'setAsCollectionVariable')
    `)
    expect(outcomes(result)).toEqual([
      ['fail', 'Not present'],
      ['fail', 'Expected "abc-999", got "abc-123"'],
      ['fail', 'Expected to match /^xyz/, got "abc-123"'],
      ['fail', 'Present, but must be absent'],
      ['fail', 'Must not be "abc-123"'],
      ['fail', 'Not present']
    ])
  })

  it('joins a header sent more than once, and saves a header into the environment', async () => {
    const result = await run(`
      gta.expectResponseToHaveHeader('X-Tag', 'a=1, b=2')
      gta.expectResponseToHaveHeader('X-Request-Id', 'envRequestId', 'setAsEnvironmentVariable')
      gta.test('saved', () => assert.equal(gta.get('envRequestId'), 'abc-123'))
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass'])
  })

  it('fails a body property for every specialHandling it does not meet', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('string.missing')
      gta.expectResponseBodyToHaveProperty('string.value', null, 'notThisExpectedKey')
      gta.expectResponseBodyToHaveProperty('string.value', 'r13FS', 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('string.value', /^r13/, 'notThisExpectedValue')
      gta.expectResponseBodyToHaveProperty('missing', 'token', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('epoch.date', 2 * 86400, 'dateAsEpoch')
      gta.expectResponseBodyToHaveProperty('when', new Date(Date.now() - 60000).toISOString(), 'dateWithin5Sec')
      gta.expectResponseBodyToHaveProperty('score', 98, 'integerWithin2')
      gta.expectResponseBodyToHaveProperty('string', null, 'isArray')
      gta.expectResponseBodyToHaveProperty('roles', null, 'isArrayAndEmpty')
      gta.expectResponseBodyToHaveProperty('empty', null, 'isArrayAndNotEmpty')
      gta.expectResponseBodyToHaveProperty('roles', 3, 'isArrayAndHasLength')
    `)
    expect(result.error).toBeNull()
    expect(outcomes(result)).toEqual([
      ['fail', 'Not present in the response body'],
      ['fail', 'Present, but must be absent'],
      ['fail', 'Must not be "r13FS"'],
      ['fail', 'Must not match /^r13/, got "r13FS"'],
      ['fail', 'Not present in the response body'],
      ['fail', expect.stringMatching(/^Expected the date \d{4}-\d{2}-\d{2}, got /)],
      ['fail', expect.stringMatching(/^Expected within 5s of .*\(\d+\.\ds off\)$/)],
      ['fail', 'Expected 98 ± 2, got 101'],
      ['fail', 'Expected an array, got an object'],
      ['fail', 'Expected an empty array, got 2 items'],
      ['fail', 'Expected a non-empty array, got an empty one'],
      ['fail', 'Expected 3 items, got 2']
    ])
  })

  it('turns a misused argument into a failed check named for the function', async () => {
    const result = await run(`
      gta.expectResponseStatusCodeToBe('', 'setAsCollectionVariable')
      gta.expectResponseToHaveHeader('X-Request-Id', 5, 'setAsEnvironmentVariable')
      gta.expectResponseBodyToHaveProperty('roles', '2', 'isArrayAndHasLength')
      gta.expectResponseBodyToHaveUnorderedArray('roles', 'admin')
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', 'owner')
      gta.ignoreResponseBodyArrayObjectProperty('account', 5)
      gta.expectResponseStatusCodeToBe(200)
    `)
    expect(result.error).toBeNull()
    expect(result.assertions.map((a) => [a.name, a.status, a.message])).toEqual([
      [
        'expectResponseStatusCodeToBe',
        'fail',
        'The variable name to set must be a non-empty string, got ""'
      ],
      [
        'expectResponseToHaveHeader',
        'fail',
        'The variable name to set must be a non-empty string, got 5'
      ],
      [
        'expectResponseBodyToHaveProperty',
        'fail',
        'isArrayAndHasLength needs the length as a number, got "2"'
      ],
      [
        'expectResponseBodyToHaveUnorderedArray',
        'fail',
        'validationList must be an array, got "admin"'
      ],
      [
        'expectResponseBodyToHaveUnorderedArrayNotThisItem',
        'fail',
        'validationList must be an array, got "owner"'
      ],
      [
        'ignoreResponseBodyArrayObjectProperty',
        'fail',
        'jsonPathOfObjectProperty is a string, such as "user.name", or a list of keys, such as ["user", "name"]; got 5'
      ],
      [expect.any(String), 'pass', undefined]
    ])
  })

  it('saves plain values as they are, and an object, an array or every item as JSON text', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('roles', 'savedRoles', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('string', 'savedObject', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('account[].id.value', 'savedIds', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('null.value', 'savedNull', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('number.value', 'savedNumber', 'setAsEnvironmentVariable')
      gta.expectResponseBodyToHaveProperty('boolean.value', 'savedBoolean', 'setAsEnvironmentVariable')
      gta.test('saved', () => {
        assert.equal(gta.get('savedRoles'), '["viewer","admin"]')
        assert.equal(gta.get('savedObject'), '{"value":"r13FS"}')
        assert.equal(gta.get('savedIds'), '["b","a"]')
        assert.equal(gta.get('savedNull'), null)
        assert.equal(gta.get('savedNumber'), 12345)
        assert.equal(gta.get('savedBoolean'), true)
      })
    `)
    expect(result.error).toBeNull()
    expect(statuses(result)).toEqual(Array(7).fill('pass'))
  })

  it('checks every item of a path with [], and finds nothing in an empty array', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('account[].balance', /^\\d+$/)
      gta.expectResponseBodyToHaveProperty('account[].description', 'Savings')
      gta.expectResponseBodyToHaveProperty('empty[].id')
    `)
    expect(statuses(result)).toEqual(['pass', 'fail', 'fail'])
  })

  it('fails an unordered array missing an item, or holding one it must not', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('roles', ['admin', 'owner'])
      gta.expectResponseBodyToHaveUnorderedArray('account', [{ description: 'Checking', balance: 20 }])
      gta.expectResponseBodyToHaveUnorderedArray('account', [{ description: 'Checking', balance: 10 }])
      gta.expectResponseBodyToHaveUnorderedArray('account', [
        { pathToProperty: 'description', expectedValue: 'Brokerage' }
      ])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', ['owner', 'viewer'])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [{ description: 'Savings' }])
    `)
    expect(outcomes(result)).toEqual([
      ['fail', 'Missing from the array: "owner"'],
      ['pass', undefined],
      ['fail', 'Missing from the array: {"description":"Checking","balance":10}'],
      ['fail', 'Missing from the array: {"description":"Brokerage"}'],
      ['fail', 'Must not contain: "viewer"'],
      ['fail', 'Must not contain: {"description":"Savings"}']
    ])
  })

  it('matches patterns in a list of values, as items and as properties of an object', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('roles', [/^ADMIN$/i, 'viewer'])
      gta.expectResponseBodyToHaveUnorderedArray('account', [{ description: /^Check/, balance: 20 }])
      gta.expectResponseBodyToHaveUnorderedArray('roles', [/^own/])
      gta.expectResponseBodyToHaveUnorderedArray('account', [/Savings/])
      gta.expectResponseBodyToHaveUnorderedArray('account', [{ description: /^Brok/ }])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', ['owner', /^own/])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('roles', [/^view/])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [{ description: /^Sav/ }])
    `)
    expect(outcomes(result)).toEqual([
      ['pass', undefined],
      ['pass', undefined],
      ['fail', 'Missing from the array: /^own/'],
      // Tested as text, a pattern never matches an object item.
      ['fail', 'Missing from the array: /Savings/'],
      ['fail', 'Missing from the array: { description: matches /^Brok/ }'],
      ['pass', undefined],
      ['fail', 'Must not contain: /^view/'],
      ['fail', 'Must not contain: { description: matches /^Sav/ }']
    ])
    expect(result.assertions[0]?.name).toBe('roles contains /^ADMIN$/i, "viewer"')
  })

  it('tests a number against a pattern as text, and counts what a pattern matched for strict validation', async () => {
    const queue = await run(
      `gta.expectResponseBodyToHaveUnorderedArray('jobs', [{ group: /^2$/, name: 'b' }])`,
      { GET: `${origin}/queue` }
    )
    expect(statuses(queue)).toEqual(['pass'])
    const result = await run(`
      gta.useStrictValidation()
      gta.expectResponseBodyToHaveUnorderedArray('roles', [/^adm/, /^view/])
      gta.expectResponseBodyToHaveUnorderedArray('account', [{ description: /^Check/ }])
    `)
    const strict = result.assertions.find((a) => a.target === 'strict')!
    expect(strict.unasserted).not.toContain('roles[0]')
    expect(strict.unasserted).not.toContain('roles[1]')
    expect(strict.unasserted).not.toContain('account[1].description')
    expect(strict.unasserted).toContain('account[1].balance')
  })

  it('describes a validation list’s item as written, patterns and specialHandling included', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('account', [
        { pathToProperty: 'id.value', expectedValue: 'z' },
        { pathToProperty: 'description', expectedValue: /^Brok/ },
        { pathToProperty: 'balance', expectedValue: 19, specialHandling: 'integerWithin1' },
        { pathToProperty: 'nickname', expectedValue: null, specialHandling: 'notThisExpectedKey' },
        { pathToProperty: 'id.value', expectedValue: 'brokerageId', specialHandling: 'setAsCollectionVariable' }
      ])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [
        { pathToProperty: 'description', compareValue: /^Sav/ }
      ])
    `)
    const item =
      '{ id.value: "z" → {{brokerageId}}, description: matches /^Brok/, balance: 19 ± 1, nickname: absent }'
    expect(result.assertions.map((a) => [a.name, a.expected, a.message])).toEqual([
      ['account contains 1 item', `contains ${item}`, `Missing from the array: ${item}`],
      [
        'account does not contain { description: matches /^Sav/ }',
        'does not contain { description: matches /^Sav/ }',
        'Must not contain: { description: matches /^Sav/ }'
      ]
    ])
  })

  it('passes …NotThisItem for an entry without compareValue, which matches no item', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [
        { pathToProperty: 'description', expectedValue: 'Checking' }
      ])
    `)
    expect(statuses(result)).toEqual(['pass'])
  })
})

describe('sortResponseBodyArrays', () => {
  it('sorts by the newest property first, the earlier ones breaking ties, items without it last', async () => {
    const result = await run(
      `
      gta.expectResponseBodyToHaveProperty('jobs.0.name', 'b')
      gta.sortResponseBodyArrays('name')
      gta.sortResponseBodyArrays('group')
      gta.expectResponseBodyToHaveProperty('jobs.0.name', 'a')
      gta.expectResponseBodyToHaveProperty('jobs.1.name', 'c')
      gta.expectResponseBodyToHaveProperty('jobs.2.name', 'b')
      gta.expectResponseBodyToHaveProperty('jobs.3.name', 'z')
      gta.test('res.body keeps the order received', () => assert.equal(res.body.jobs[0].name, 'b'))
    `,
      { GET: `${origin}/queue` }
    )
    expect(statuses(result)).toEqual(Array(6).fill('pass'))
    expect(result.sortedBy).toEqual(['group', 'name'])
  })

  it('warns and sorts nothing when given no property, or one it cannot read', async () => {
    const result = await run(`
      gta.sortResponseBodyArrays()
      gta.sortResponseBodyArrays('')
      gta.sortResponseBodyArrays([])
      gta.sortResponseBodyArrays(5)
      gta.sortResponseBodyArrays(['id', null])
      gta.expectResponseBodyToHaveProperty('account.0.description', 'Savings')
    `)
    expect(result.error).toBeNull()
    expect(statuses(result)).toEqual(['pass'])
    expect(result.sortedBy).toBeUndefined()
    const nameless =
      'gta.sortResponseBodyArrays() needs a property name to sort by; nothing was sorted'
    expect(result.logs?.map((log) => [log.level, log.message])).toEqual([
      ['warn', nameless],
      ['warn', nameless],
      ['warn', nameless],
      ['warn', nameless],
      [
        'warn',
        "gta.sortResponseBodyArrays(): propertyName's keys are strings or numbers; got null; nothing was sorted"
      ]
    ])
  })
})

describe('ignoring properties', () => {
  const unasserted = (result: RunResult) =>
    result.assertions.find((a) => a.target === 'strict')?.unasserted ?? []

  it('counts a property and everything inside it as checked', async () => {
    const result = await run(`
      gta.useStrictValidation()
      gta.ignoreResponseBodyProperty('decodedJwt')
      gta.ignoreResponseBodyProperty(['byId', '7'])
    `)
    const left = unasserted(result)
    expect(left.filter((path) => path.startsWith('decodedJwt') || path.startsWith('byId'))).toEqual(
      []
    )
    expect(left).toContain('string.value')
  })

  it('changes nothing, and reports nothing, without strict validation', async () => {
    const result = await run(`
      gta.ignoreResponseBodyProperty('url')
      gta.ignoreResponseBodyArrayObjectProperty('account', 'balance')
    `)
    expect(result.assertions).toEqual([])
    expect(result.error).toBeNull()
  })

  it('ignores a property of every item, as the same path with [] does', async () => {
    const perItem = await run(`
      gta.useStrictValidation()
      gta.ignoreResponseBodyArrayObjectProperty('account', 'id.value')
    `)
    const viaPath = await run(`
      gta.useStrictValidation()
      gta.ignoreResponseBodyProperty('account[].id.value')
    `)
    expect(unasserted(perItem)).not.toContain('account[0].id.value')
    expect(unasserted(perItem)).not.toContain('account[1].id.value')
    expect(unasserted(perItem)).toContain('account[1].description')
    expect(unasserted(perItem)).toEqual(unasserted(viaPath))
  })
})

describe('paths given as a list of keys, as xtest took them', () => {
  const jwtId = "['decodedJwt', 'payload', 'https://data.ia.io/ia_acct_uuid']"

  it('reach keys holding dots, and numbers read as keys of arrays and objects alike', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty(${jwtId}, 'acct-1')
      gta.expectResponseBodyToHaveProperty(${jwtId}, 'acctId', 'setAsCollectionVariable')
      gta.expectResponseBodyToHaveProperty('decodedJwt.payload["https://data.ia.io/roles"]', null, 'isArrayAndNotEmpty')
      gta.expectResponseBodyToHaveProperty(['account', 1, 'description'], 'Checking')
      gta.expectResponseBodyToHaveProperty(['byId', 7, 'city'], 'Sacramento')
      gta.test('captured', () => assert.equal(gta.get('acctId'), 'acct-1'))
    `)
    expect(result.error).toBeNull()
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
    expect(result.assertions[0]).toMatchObject({
      path: 'decodedJwt.payload["https://data.ia.io/ia_acct_uuid"]',
      name: 'decodedJwt.payload["https://data.ia.io/ia_acct_uuid"] is "acct-1"'
    })
    expect(result.assertions[3]?.path).toBe('account.1.description')
  })

  it('work in unordered-array lists, the empty key included', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray(['licenses'], [
        { pathToProperty: 'licenseKey', expectedValue: 'makerKey', specialHandling: 'setAsCollectionVariable' },
        { pathToProperty: ['modules', '', 'params', 'edition'], expectedValue: 'maker' }
      ])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('licenses', [
        { pathToProperty: ['modules', '', 'params', 'edition'], compareValue: 'enterprise' }
      ])
      gta.test('captured from the maker license', () => assert.equal(gta.get('makerKey'), 'k1'))
    `)
    expect(result.error).toBeNull()
    expect(statuses(result)).toEqual(['pass', 'pass', 'pass'])
  })

  it('count for strict validation, which names a leftover key in its quoted form', async () => {
    const result = await run(`
      gta.useStrictValidation(true)
      gta.expectResponseBodyToHaveProperty(${jwtId}, 'acct-1')
      gta.ignoreResponseBodyArrayObjectProperty(['licenses'], ['modules', '', 'params'])
    `)
    const strict = result.assertions.find((a) => a.target === 'strict')!
    expect(strict.unasserted).not.toContain('decodedJwt.payload["https://data.ia.io/ia_acct_uuid"]')
    expect(strict.unasserted).toContain('decodedJwt.payload["https://data.ia.io/roles"][0]')
    expect(strict.unasserted).not.toContain('licenses[0].modules[""].params.edition')
    expect(strict.unasserted).toContain('licenses[0].licenseKey')
  })

  it('sort arrays by a key holding nothing a string could name', async () => {
    const result = await run(`
      gta.sortResponseBodyArrays(['modules', '', 'params', 'edition'])
      gta.expectResponseBodyToHaveProperty('licenses.0.licenseKey', 'k2')
    `)
    expect(result.assertions[0]?.status).toBe('pass')
    expect(result.sortedBy).toEqual(['modules[""].params.edition'])
  })

  it('turn a path that is neither a string nor a list of keys into a failed check, and carry on', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty(5, 1)
      gta.expectResponseBodyToHaveProperty(['decodedJwt', null], 1)
      gta.expectResponseBodyToHaveProperty([], 1)
      gta.ignoreResponseBodyProperty({})
      gta.expectResponseBodyToHaveUnorderedArray('licenses', [{ pathToProperty: true, expectedValue: 1 }])
      gta.expectResponseStatusCodeToBe(200)
    `)
    expect(result.error).toBeNull()
    expect(result.assertions.map((a) => [a.status, a.message])).toEqual([
      [
        'fail',
        'jsonPathToProperty is a string, such as "user.name", or a list of keys, such as ["user", "name"]; got 5'
      ],
      ['fail', "jsonPathToProperty's keys are strings or numbers; got null"],
      ['fail', 'jsonPathToProperty is an empty list; it needs a key'],
      [
        'fail',
        'jsonPathToProperty is a string, such as "user.name", or a list of keys, such as ["user", "name"]; got {}'
      ],
      [
        'fail',
        'pathToProperty is a string, such as "user.name", or a list of keys, such as ["user", "name"]; got true'
      ],
      ['pass', undefined]
    ])
  })
})

describe('where xtest’s reading differs by strict validation, or was lenient', () => {
  const notJoined = (value: string) =>
    `[{ pathToProperty: 'description', expectedValue: ${value}, specialHandling: 'notThisExpectedValue' }]`

  it('reads a lone notThisExpectedValue entry as “no item has it” without strict validation', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('empty', ${notJoined("'Savings'")})
      gta.expectResponseBodyToHaveUnorderedArray('account', ${notJoined("'Savings'")})
      gta.expectResponseBodyToHaveUnorderedArray('account', ${notJoined('/^Brok/')})
    `)
    expect(statuses(result)).toEqual(['pass', 'fail', 'pass'])
    expect(result.assertions[1]).toMatchObject({
      name: 'account does not contain {"description":"Savings"}',
      message: 'Must not contain: {"description":"Savings"}'
    })
  })

  it('reads it as one item with another value under strict validation, turned on after it', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('empty', ${notJoined("'Savings'")})
      gta.expectResponseBodyToHaveUnorderedArray('account', ${notJoined("'Savings'")})
      gta.useStrictValidation(true)
    `)
    expect(statuses(result).slice(0, 2)).toEqual(['fail', 'pass'])
    expect(result.assertions[0]?.message).toMatch(/^Missing from the array/)
    const strict = result.assertions.find((a) => a.target === 'strict')!
    // The item it matched is accounted for: the Checking account's description.
    expect(strict.unasserted).not.toContain('account[1].description')
  })

  it('takes a RegExp compareValue in …NotThisItem', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [{ pathToProperty: 'description', compareValue: /^Sav/ }])
      gta.expectResponseBodyToHaveUnorderedArrayNotThisItem('account', [{ pathToProperty: 'description', compareValue: /^Brok/ }])
    `)
    expect(statuses(result)).toEqual(['fail', 'pass'])
  })

  it('reads a path that runs into a null as that null, for a check that it is null', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveProperty('null.value.number', null)
      gta.expectResponseBodyToHaveUnorderedArray('people', [
        { pathToProperty: 'name', expectedValue: 'Ada' },
        { pathToProperty: 'phone.number', expectedValue: null }
      ])
      gta.expectResponseBodyToHaveProperty('null.value.number', 'x')
      gta.expectResponseBodyToHaveProperty('null.value.number')
      gta.expectResponseBodyToHaveProperty('missing.number', null)
    `)
    expect(statuses(result)).toEqual(['pass', 'pass', 'fail', 'fail', 'fail'])
    expect(result.assertions[0]?.actual).toBe('null')
  })

  it('prefers an item an earlier call did not match, so the same description finds the next', async () => {
    const tier = (into: string) =>
      `gta.expectResponseBodyToHaveUnorderedArray('values', [
        { pathToProperty: 'field', expectedValue: 'tier' },
        { pathToProperty: 'value', expectedValue: 'gold' },
        { pathToProperty: 'org', expectedValue: '${into}', specialHandling: 'setAsCollectionVariable' }
      ])`
    const result = await run(`
      gta.useStrictValidation(true)
      ${tier('first')}
      ${tier('second')}
      gta.test('each call took its own item', () => {
        assert.equal(gta.get('first'), 'o1')
        assert.equal(gta.get('second'), 'o2')
      })
    `)
    expect(named(result, 'each call').status).toBe('pass')
    const strict = result.assertions.find((a) => a.target === 'strict')!
    expect(strict.unasserted).not.toContain('values[0].org')
    expect(strict.unasserted).not.toContain('values[1].org')
  })

  it('starts over after a sort, whose indexes name other items', async () => {
    const result = await run(`
      gta.expectResponseBodyToHaveUnorderedArray('values', [
        { pathToProperty: 'org', expectedValue: 'first', specialHandling: 'setAsCollectionVariable' }
      ])
      gta.sortResponseBodyArrays('org')
      gta.expectResponseBodyToHaveUnorderedArray('values', [
        { pathToProperty: 'org', expectedValue: 'again', specialHandling: 'setAsCollectionVariable' }
      ])
      gta.test('both took the first item', () => {
        assert.equal(gta.get('first'), 'o1')
        assert.equal(gta.get('again'), 'o1')
      })
    `)
    expect(named(result, 'both took').status).toBe('pass')
  })

  it('passes strict validation on a body it cannot read, binary or HTML', async () => {
    for (const where of ['download', 'page']) {
      const result = await run('gta.useStrictValidation(true)', { GET: `${origin}/${where}` })
      expect(result.assertions).toEqual([
        { name: 'Strict: every body property is asserted', status: 'pass', target: 'strict' }
      ])
    }
    const checked = await run(
      `gta.useStrictValidation(true)
      gta.expectResponseBodyToHaveProperty('x')`,
      { GET: `${origin}/download` }
    )
    expect(checked.assertions[0]).toMatchObject({ name: 'Response body', status: 'fail' })
  })
})

describe('turning strict validation on and off', () => {
  /** On when the step reported a strict check, off when it did not. */
  const strictness = (result: RunResult) =>
    result.assertions.some((a) => a.target === 'strict') ? 'on' : 'off'

  /** A step's tests run with these variable layers, lowest first, and this process environment. */
  const runWith = (tests: string, layers: VarLayer[], env: Record<string, string> = {}) =>
    runRequest({
      step: StepSchema.parse({ GET: `${origin}/thing`, tests }),
      scope: new VariableScope(layers, env)
    })

  const global: VarLayer = { source: '../global/project.yml', vars: { strictValidation: true } }
  const project: VarLayer = { source: 'project.yml', vars: { strictValidation: false } }
  const fromVar = `gta.useStrictValidation(gta.get('strictValidation'))`

  it('is on with no argument or true, and off with false or never called', async () => {
    expect(strictness(await run('gta.useStrictValidation()'))).toBe('on')
    expect(strictness(await run('gta.useStrictValidation(true)'))).toBe('on')
    expect(strictness(await run('gta.useStrictValidation(false)'))).toBe('off')
    expect(strictness(await run('gta.expectResponseStatusCodeToBe(200)'))).toBe('off')
  })

  it('lets a step overrule the collection, the last call winning', async () => {
    const on: Collection = { steps: [], tests: 'gta.useStrictValidation()' }
    const off: Collection = { steps: [], tests: 'gta.useStrictValidation(false)' }
    expect(strictness(await run('gta.useStrictValidation(false)', {}, on))).toBe('off')
    expect(strictness(await run('gta.useStrictValidation(true)', {}, off))).toBe('on')
    expect(strictness(await run('gta.expectResponseStatusCodeToBe(200)', {}, on))).toBe('on')
  })

  it('reads the text true as on, and any other text or number as off', async () => {
    expect(strictness(await run(`gta.useStrictValidation('true')`))).toBe('on')
    for (const value of [`'false'`, `'TRUE'`, `'yes'`, '1', '0', 'null']) {
      expect(strictness(await run(`gta.useStrictValidation(${value})`)), value).toBe('off')
    }
  })

  it('follows a variable, the project’s value over the global project’s', async () => {
    expect(strictness(await runWith(fromVar, [global]))).toBe('on')
    expect(strictness(await runWith(fromVar, [global, project]))).toBe('off')
  })

  it('follows a variable the process environment overrides with text', async () => {
    expect(strictness(await runWith(fromVar, [global], { strictValidation: 'false' }))).toBe('off')
    expect(strictness(await runWith(fromVar, [project], { strictValidation: 'true' }))).toBe('on')
  })

  it('is on for a variable nothing defines, unless the script gives a fallback', async () => {
    // gta.get() answers undefined, and an undefined argument takes the default: true.
    expect(strictness(await runWith(fromVar, []))).toBe('on')
    const fallback = `gta.useStrictValidation(gta.get('strictValidation') ?? false)`
    expect(strictness(await runWith(fallback, []))).toBe('off')
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

describe('gta.test', () => {
  it('fails with the reason a promise rejects with, or whatever was thrown, as text', async () => {
    const result = await run(`
      gta.test('rejects', async () => { throw new Error('nope') })
      gta.test('rejects with text', () => Promise.reject('no reason'))
      gta.test('throws text', () => { throw 'plain text' })
      gta.test('gta.assert', () => gta.assert.equal(1, 2))
      gta.test(42, () => {})
    `)
    expect(result.assertions.map((a) => [a.name, a.status, a.message])).toEqual([
      ['rejects', 'fail', 'nope'],
      ['rejects with text', 'fail', 'no reason'],
      ['throws text', 'fail', 'plain text'],
      ['gta.assert', 'fail', expect.stringMatching(/1 !== 2/)],
      ['42', 'pass', undefined]
    ])
  })

  it('returns a promise that settles when the check does', async () => {
    const result = await run(`
      const order = []
      await gta.test('slow', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push('slow')
      })
      order.push('after')
      gta.test('waited', () => assert.deepEqual(order, ['slow', 'after']))
    `)
    expect(statuses(result)).toEqual(['pass', 'pass'])
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

  it('sets undefined as null: it reads == null, and replaces what was there', async () => {
    const scope = new VariableScope()
    scope.set('email', 'old@example.com')
    const result = await runRequest({
      step: StepSchema.parse({
        GET: `${origin}/x{{email}}{{never}}`,
        before: {
          script: `gta.set('email', undefined); gta.set('never', undefined, { scope: 'run' })`
        },
        tests: `gta.test('reads == null', () => assert.ok(gta.get('email') == null))`
      }),
      scope
    })
    expect(scope.get('email')).toBeNull()
    expect(scope.get('never')).toBeNull()
    expect(result.request.url).toBe(`${origin}/x`)
    expect(statuses(result)).toEqual(['pass'])
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

  it('refuses every function that works on the response, each by name', () => {
    const shared = ['get', 'set', 'flag', 'uuid', 'uuidv7', 'randomInt', 'date', 'assert']
    const tests = testsGta({ session: {} as CheckSession, scope: new VariableScope(), pending: [] })
    const responseOnly = Object.keys(tests).filter(
      (name) => !shared.includes(name) && !['skip', 'skipRest'].includes(name)
    )
    expect(responseOnly.sort()).toEqual([
      'expectResponseBodyToHaveProperty',
      'expectResponseBodyToHaveUnorderedArray',
      'expectResponseBodyToHaveUnorderedArrayNotThisItem',
      'expectResponseStatusCodeToBe',
      'expectResponseToHaveHeader',
      'ignoreResponseBodyArrayObjectProperty',
      'ignoreResponseBodyProperty',
      'sortResponseBodyArrays',
      'test',
      'useStrictValidation'
    ])
    const before = preRequestGta(new VariableScope()) as unknown as Record<string, () => void>
    for (const name of responseOnly) {
      expect(() => before[name]!(), name).toThrow(
        `gta.${name}() checks a response, so it belongs in tests, not before.script`
      )
    }
    for (const name of shared) expect(before[name], name).toBeDefined()
  })
})

describe('variables, flags and skips, called directly', () => {
  const noSession = {} as CheckSession

  it('gets a variable with its type, and undefined when no layer sets it', () => {
    const scope = new VariableScope([
      { source: 'project.yml', vars: { retries: 3, strict: true, region: 'eu', none: null } }
    ])
    const gta = preRequestGta(scope)
    expect(gta.get('retries')).toBe(3)
    expect(gta.get('strict')).toBe(true)
    expect(gta.get('region')).toBe('eu')
    expect(gta.get('none')).toBeNull()
    expect(gta.get('missing')).toBeUndefined()
  })

  it('sets plain values as they are, objects and arrays as JSON text, and undefined as null', () => {
    const scope = new VariableScope()
    const gta = preRequestGta(scope)
    const values: Record<string, unknown> = {
      text: 'a',
      count: 2,
      off: false,
      none: null,
      list: ['a', 'b'],
      object: { id: 1 },
      gone: undefined
    }
    for (const [name, value] of Object.entries(values)) gta.set(name, value)
    expect(Object.fromEntries(Object.keys(values).map((name) => [name, scope.get(name)]))).toEqual({
      text: 'a',
      count: 2,
      off: false,
      none: null,
      list: '["a","b"]',
      object: '{"id":1}',
      gone: null
    })
    expect(scope.originOf('text')).toBe('script')
    // The same in tests, where the step's checks have run.
    testsGta({ session: noSession, scope, pending: [] }).set('text', 'b')
    expect(scope.get('text')).toBe('b')
  })

  it('refuses a scope other than run', () => {
    const gta = preRequestGta(new VariableScope())
    expect(() => gta.set('a', 1, { scope: 'row' })).toThrow(
      `gta.set(): scope is 'run' or left out, got "row"`
    )
    expect(() => gta.set('a', 1, { scope: 'run' })).not.toThrow()
  })

  it('reads a flag the run knows, in either script, and refuses one it does not', () => {
    const scope = new VariableScope()
    expect(() => preRequestGta(scope).flag('pricing')).toThrow(UnknownFlagError)
    scope.flags = { pricing: 'v2', limit: 5, beta: false }
    const before = preRequestGta(scope)
    expect(before.flag('pricing')).toBe('v2')
    expect(before.flag('limit')).toBe(5)
    expect(before.flag('beta')).toBe(false)
    expect(() => before.flag('nope')).toThrow(UnknownFlagError)
    expect(testsGta({ session: noSession, scope, pending: [] }).flag('pricing')).toBe('v2')
  })

  it('keeps the first reason to skip, and names the script when none is given', () => {
    const control = newStepControl()
    const gta = preRequestGta(new VariableScope(), control)
    gta.skip('   ')
    gta.skip('second')
    expect(control).toEqual({ skip: 'gta.skip() in before.script', rest: null })
    gta.skipRest('the rest')
    expect(control).toEqual({ skip: 'gta.skip() in before.script', rest: 'the rest' })
  })

  it('skips this step and the rest from before.script, and only the rest from tests', () => {
    const before = newStepControl()
    preRequestGta(new VariableScope(), before).skipRest('done')
    expect(before).toEqual({ skip: 'done', rest: 'done' })

    const after = newStepControl()
    const gta = testsGta({
      session: noSession,
      scope: new VariableScope(),
      pending: [],
      control: after
    })
    gta.skipRest(null as unknown as string)
    gta.skipRest('later')
    expect(after).toEqual({ skip: null, rest: 'gta.skipRest() in an earlier step' })
    expect(() => gta.skip()).toThrow(/belongs in before\.script/)
  })
})

describe('what a body check covered', () => {
  const coveredBy = async (tests: string) => (await run(tests)).assertions[0]?.covered

  it('is the properties an unordered check matched, in the items it matched', async () => {
    expect(
      await coveredBy(
        "gta.expectResponseBodyToHaveUnorderedArray('account', [{ pathToProperty: 'id.value', expectedValue: 'a' }])"
      )
    ).toEqual(['account[1].id.value'])
  })

  it('is the whole value an equality compared, and nothing a length measured', async () => {
    expect(
      await coveredBy("gta.expectResponseBodyToHaveProperty('string', { value: 'r13FS' })")
    ).toEqual(['string'])
    expect(
      await coveredBy("gta.expectResponseBodyToHaveProperty('roles', 2, 'isArrayAndHasLength')")
    ).toEqual([])
  })
})

describe('where each check was made', () => {
  const lines = (result: RunResult) => result.assertions.map((a) => a.source)

  it('notes the line of the step’s tests each check was made on', async () => {
    const result = await run(
      [
        'gta.expectResponseStatusCodeToBe(200)',
        '',
        "gta.expectResponseToHaveHeader('X-Request-Id')",
        "gta.test('named', () => assert.ok(true))"
      ].join('\n')
    )
    expect(lines(result)).toEqual([
      { script: 'step', line: 1 },
      { script: 'step', line: 3 },
      { script: 'step', line: 4 }
    ])
  })

  it('notes a helper’s own line, and a line after an await', async () => {
    const result = await run(
      [
        'function header() {',
        "  gta.expectResponseToHaveHeader('X-Request-Id')",
        '}',
        'header()',
        'await new Promise((resolve) => setTimeout(resolve, 1))',
        'gta.expectResponseStatusCodeToBe(200)'
      ].join('\n')
    )
    expect(lines(result)).toEqual([
      { script: 'step', line: 2 },
      { script: 'step', line: 6 }
    ])
  })

  it('notes a check file’s checks against the line that called it', async () => {
    const result = await runRequest({
      step: StepSchema.parse({
        GET: `${origin}/thing`,
        tests: 'gta.expectResponseStatusCodeToBe(200)\nchecks.common.ok()'
      }),
      checks: [
        {
          name: 'common',
          filename: 'checks/common.js',
          code: "export function ok() {\n  gta.expectResponseToHaveHeader('X-Request-Id')\n}\n"
        }
      ],
      scope: new VariableScope()
    })
    expect(result.error).toBeNull()
    expect(lines(result)).toEqual([
      { script: 'step', line: 1 },
      // The line that called it, and the check file's own line that made it.
      { script: 'step', line: 2, check: { file: 'checks/common.js', line: 2 } }
    ])
  })

  it('tells the collection’s checks from the step’s, and strict validation’s from both', async () => {
    const collection: Collection = {
      steps: [],
      tests: 'gta.useStrictValidation()\ngta.expectResponseStatusCodeToBe(200)'
    }
    const result = await run('\ngta.expectResponseToHaveHeader("X-Request-Id")', {}, collection)
    expect(lines(result)).toEqual([
      { script: 'collection', line: 2 },
      { script: 'step', line: 2 },
      undefined
    ])
    expect(result.assertions[2]?.target).toBe('strict')
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

describe('checkScriptSyntax for a check file', () => {
  const asCheckFile = (code: string) => checkScriptSyntax(code, { checkFile: true })

  it('accepts each of the three ways a check file exports, as a run does', () => {
    const code = [
      'export function same(id) {',
      "  gta.expectResponseBodyToHaveProperty('id', id)",
      '}',
      '  export async function later() {}',
      'export const LIMIT = 10'
    ].join('\n')
    expect(asCheckFile(code)).toBeNull()
    // As a script it would not parse: export is for check files.
    expect(checkScriptSyntax(code)?.message).toBe("SyntaxError: Unexpected token 'export'")
  })

  it('still reports a real error, on its line', () => {
    expect(asCheckFile('export function a() {}\nconst = 1')).toMatchObject({
      line: 2,
      column: 7,
      message: "SyntaxError: Unexpected token '='"
    })
    expect(asCheckFile('export function a() {\n  b(')).toMatchObject({
      line: 2,
      message: 'SyntaxError: Unexpected end of input'
    })
  })

  it('puts an error on an exporting line at its column in the author’s line', () => {
    // `)` is the line's 18th character as written, whatever export became for the run.
    expect(asCheckFile('export function a(x, ) {}\nexport const b = )')).toMatchObject({
      line: 2,
      column: 18,
      length: 1,
      message: "SyntaxError: Unexpected token ')'"
    })
    expect(asCheckFile('  export async function a() { const = 1 }')).toMatchObject({
      line: 1,
      column: 37
    })
  })

  it('rejects a top-level await, which a run of a check file rejects too', () => {
    expect(asCheckFile('await setup()\nexport const ready = true')).toMatchObject({ line: 1 })
  })
})

describe('generated values', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

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

  it('makes a different UUID on every call', () => {
    const gta = preRequestGta(new VariableScope())
    expect(gta.uuid()).not.toBe(gta.uuid())
    expect(gta.uuidv7()).not.toBe(gta.uuidv7())
  })

  it('reaches both ends of a range, given either way round, rounding fractions inward', () => {
    const gta = preRequestGta(new VariableScope())
    const random = vi.spyOn(Math, 'random')
    random.mockReturnValue(0)
    expect([gta.randomInt(5, 7), gta.randomInt(7, 5), gta.randomInt(1.2, 3.8)]).toEqual([5, 5, 2])
    random.mockReturnValue(0.999999)
    expect([gta.randomInt(5, 7), gta.randomInt(7, 5), gta.randomInt(1.2, 3.8)]).toEqual([7, 7, 3])
    expect(gta.randomInt(4, 4)).toBe(4)
  })

  it('formats the time now, moved by an offset, in the zone asked for', () => {
    const now = Date.UTC(2026, 9, 1, 12, 30, 15)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const gta = preRequestGta(new VariableScope())
    expect(gta.date('%F %T', 0, 'utc')).toBe('2026-10-01 12:30:15')
    expect(gta.date('%F %T', 86400, 'utc')).toBe('2026-10-02 12:30:15')
    expect(gta.date('%F %T', -3600, 'Z')).toBe('2026-10-01 11:30:15')
    expect(gta.date('%H:%M%z', 0, 'U')).toBe('04:30-0800')
    expect(gta.date('%H:%M%z', 0, 'A')).toBe('13:30+0100')
    expect(gta.date('%H:%M%z', 0, 'IST')).toBe('18:00+0530')
    expect(gta.date('%FT%T%z', 0, 'America/New_York')).toBe('2026-10-01T08:30:15-0400')
    expect(gta.date('%F %T')).toBe(strftime('%F %T', new Date(now), 'local'))
    expect(gta.date('%Q')).toBe('%Q')
  })

  it('reads every military zone letter, and IST as India', () => {
    expect(zoneFor('M')).toBe('Etc/GMT-12')
    expect(zoneFor('N')).toBe('Etc/GMT+1')
    expect(zoneFor('Y')).toBe('Etc/GMT+12')
    expect(zoneFor('IST')).toBe('Asia/Kolkata')
    expect(zoneFor('utc')).toBe('utc')
    expect(zoneFor('local')).toBe('local')
  })
})

describe('responseView', () => {
  it('gives scripts a body kept as base64 as its text, read as UTF-8', () => {
    const view = responseView(
      {
        status: 200,
        statusText: 'OK',
        url: 'http://x/doc.pdf',
        headers: [{ name: 'content-type', value: 'application/pdf' }],
        body: Buffer.concat([Buffer.from('%PDF-1.7 '), Buffer.from([0xe2])]).toString('base64'),
        bodyKind: 'binary',
        bodyEncoding: 'base64',
        sizeBytes: 10,
        redirectCount: 0,
        timings: { startedAt: 0, ttfbMs: 1, totalMs: 1 }
      },
      (value) => value
    )
    expect(view.text).toBe('%PDF-1.7 \ufffd')
    expect(view.body).toBeUndefined()
  })
})
