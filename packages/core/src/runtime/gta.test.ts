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
