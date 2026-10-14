import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema, StepSchema, type Collection } from '../model/documents.js'
import type { RunResult } from '../model/run.js'
import { runRequest } from './runRequest.js'
import { VariableScope } from '../vars/scope.js'

/**
 * A step whose response is an event stream: read as a list of events, checked
 * with the same functions as any body, and stopped by settings that inherit
 * like any other (SPEC.md §2.3, §3).
 */

let server: http.Server
let origin: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (req.url === '/prices') {
      // Open until the client goes: one event now, then one every 10ms.
      res.write('event: subscribed\ndata: {"symbol":"ACME"}\n\n')
      let price = 100
      const every = setInterval(
        () =>
          res.write(`id: ${price}\nevent: price\ndata: {"symbol":"ACME","price":${price++}}\n\n`),
        10
      )
      res.on('close', () => clearInterval(every))
      return
    }
    if (req.url === '/orders') {
      // Open until the client goes: an order.created every 10ms, each a new order.
      let id = 1
      const every = setInterval(
        () => res.write(`event: order.created\ndata: {"id":${id++}}\n\n`),
        10
      )
      res.on('close', () => clearInterval(every))
      return
    }
    // An answer streamed to a POST, which the server closes.
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const { prompt } = JSON.parse(body) as { prompt: string }
      for (const word of ['Hello', ',', ` ${prompt}`]) res.write(`data: {"delta":"${word}"}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const run = (
  step: Record<string, unknown>,
  collection?: Collection,
  scope = new VariableScope()
): Promise<RunResult> =>
  runRequest({
    step: StepSchema.parse(step),
    ...(collection ? { collection } : {}),
    scope
  })

const failed = (result: RunResult) =>
  result.assertions.filter((a) => a.status === 'fail').map((a) => `${a.name}: ${a.message}`)

describe('a step reading an event stream', () => {
  it('checks events by path, and stops at maxEvents', async () => {
    const result = await run({
      GET: `${origin}/prices`,
      settings: { maxEvents: 3 },
      tests: [
        'gta.expectResponseStatusCodeToBe(200)',
        "gta.expectResponseBodyToHaveProperty('[0].event', 'subscribed')",
        "gta.expectResponseBodyToHaveProperty('[1].data.symbol', 'ACME')",
        "gta.expectResponseBodyToHaveProperty('[1].data.price', 100)",
        "gta.expectResponseBodyToHaveProperty('[2].id', '101')",
        "gta.expectResponseBodyToHaveProperty('[3]', null, 'notThisExpectedKey')"
      ].join('\n')
    })
    expect(failed(result)).toEqual([])
    expect(result.status).toBe('pass')
    expect(result.response?.bodyKind).toBe('events')
    expect(result.response?.stream?.endedBy).toBe('maxEvents')
  })

  it('takes maxEvents and streamTimeout from the collection, as any setting', async () => {
    const collection = CollectionSchema.parse({
      id: 'prices',
      settings: { maxEvents: 2, streamTimeout: 5000 },
      steps: []
    })
    const result = await run({ GET: `${origin}/prices` }, collection)
    expect(result.response?.stream?.endedBy).toBe('maxEvents')
    expect(result.response?.stream?.at).toHaveLength(2)

    // A step's own wins: a short window stops it first.
    const own = await run(
      { GET: `${origin}/prices`, settings: { maxEvents: 0, streamTimeout: 35 } },
      collection
    )
    expect(own.response?.stream?.endedBy).toBe('streamTimeout')
  })

  it('gives scripts the events as res.body, the text as res.text, and res.stream', async () => {
    const result = await run({
      POST: `${origin}/chat`,
      body: { json: '{ "prompt": "Ada" }' },
      tests: [
        "gta.test('the answer', () => {",
        "  const words = res.body.filter((e) => e.data !== '[DONE]').map((e) => e.data.delta)",
        "  assert.equal(words.join(''), 'Hello, Ada')",
        '})',
        "gta.test('ends with [DONE]', () => assert.equal(res.body.at(-1).data, '[DONE]'))",
        'gta.test(\'as sent\', () => assert.ok(res.text.startsWith(\'data: {"delta":"Hello"}\\n\\n\')))',
        "gta.test('closed by the server', () => assert.equal(res.stream.endedBy, 'close'))",
        "gta.test('a time per event', () => assert.equal(res.stream.at.length, 4))"
      ].join('\n')
    })
    expect(result.error).toBeNull()
    expect(failed(result)).toEqual([])
    expect(result.assertions).toHaveLength(5)
  })

  it('accounts for every event under strict validation, and unordered checks find them', async () => {
    const result = await run({
      POST: `${origin}/chat`,
      body: { json: '{ "prompt": "Ada" }' },
      tests: [
        'gta.useStrictValidation()',
        "gta.expectResponseBodyToHaveUnorderedArray('', [{ data: { delta: ',' } }, { data: '[DONE]' }])",
        "gta.expectResponseBodyToHaveProperty('[0].data.delta', 'Hello')"
      ].join('\n')
    })
    const strict = result.assertions.find((a) => a.target === 'strict')
    expect(failed(result).filter((f) => !f.startsWith('Strict'))).toEqual([])
    expect(strict?.status).toBe('fail')
    expect(strict?.unasserted).toEqual(['[2].data.delta'])
  })
})

describe('untilTestsPass', () => {
  /** Tests that pass on the third order, whichever event it arrives as. */
  const third = "gta.test('order 3', () => assert.equal(res.body.at(-1).data.id, 3))"

  it('stops at the event the tests want, among others of the same name', async () => {
    const result = await run({
      GET: `${origin}/orders`,
      settings: { streamTimeout: 5000 },
      tests: third
    })
    expect(failed(result)).toEqual([])
    expect(result.response?.stream?.endedBy).toBe('testsPassed')
    expect(result.response?.stream?.at).toHaveLength(3)
  })

  it('is on by default, and off reads on whatever the tests say', async () => {
    const tests = "gta.test('order 2 came', () => assert.ok(res.body.some((e) => e.data.id === 2)))"
    const on = await run({ GET: `${origin}/orders`, settings: { maxEvents: 4 }, tests })
    expect(on.response?.stream).toMatchObject({
      endedBy: 'testsPassed',
      at: [expect.any(Number), expect.any(Number)]
    })

    const collection = CollectionSchema.parse({
      id: 'orders',
      settings: { untilTestsPass: false },
      steps: []
    })
    const off = await run(
      { GET: `${origin}/orders`, settings: { maxEvents: 4 }, tests },
      collection
    )
    expect(failed(off)).toEqual([])
    expect(off.response?.stream?.endedBy).toBe('maxEvents')
    expect(off.response?.stream?.at).toHaveLength(4)
  })

  it('does not wait on tests that never look at the events', async () => {
    const result = await run({
      GET: `${origin}/orders`,
      settings: { maxEvents: 3 },
      tests: [
        'gta.expectResponseStatusCodeToBe(200)',
        "gta.expectResponseToHaveHeader('content-type', 'text/event-stream')",
        "gta.test('in time', () => assert.ok(res.time < 5000))"
      ].join('\n')
    })
    expect(failed(result)).toEqual([])
    expect(result.response?.stream?.endedBy).toBe('maxEvents')
  })

  it('keeps only what the tests set and log on the events the reading stopped at', async () => {
    const scope = new VariableScope()
    const sets: Array<{ name: string; value: unknown }> = []
    scope.onSet = ({ name, value }) => sets.push({ name, value })
    const result = await run(
      {
        GET: `${origin}/orders`,
        settings: { streamTimeout: 5000 },
        tests: [
          "gta.set('seen', res.body.length)",
          "console.log('events', res.body.length)",
          "gta.expectResponseBodyToHaveProperty('[0].data.id', 'firstId', 'setAsCollectionVariable')",
          third
        ].join('\n')
      },
      undefined,
      scope
    )
    expect(failed(result)).toEqual([])
    expect(sets).toEqual([
      { name: 'seen', value: 3 },
      { name: 'firstId', value: 1 }
    ])
    expect(result.logs?.map((entry) => entry.message)).toEqual(['events 3'])
  })

  it('reads on until another setting stops it when the tests never pass, then fails', async () => {
    const result = await run({
      GET: `${origin}/orders`,
      settings: { streamTimeout: 60 },
      tests: "gta.test('order 999', () => assert.equal(res.body.at(-1).data.id, 999))"
    })
    expect(result.status).toBe('fail')
    expect(result.response?.stream?.endedBy).toBe('streamTimeout')
  })
})
