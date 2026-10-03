import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema, type Collection } from '../model/documents.js'
import type { RunResult } from '../model/run.js'
import { Connections, type ConnectionState } from './connections.js'
import { runSuite } from './runSuite.js'

/**
 * Connections (SPEC.md §2.11): an event stream one step opens, held open for
 * later steps to read — the order placed between them shows up on it.
 */

let server: http.Server
let origin: string
/** The open order streams, to tell of each order placed. */
const watchers = new Set<http.ServerResponse>()
/** Resolves when the server sees an order stream close. */
let streamClosed: Promise<void>
let orders = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/orders/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: subscribed\ndata: {"topic":"orders"}\n\n')
      watchers.add(res)
      streamClosed = new Promise((resolve) =>
        res.on('close', () => {
          watchers.delete(res)
          resolve()
        })
      )
      return
    }
    if (url.pathname === '/orders' && req.method === 'POST') {
      const id = ++orders
      for (const watcher of watchers) {
        watcher.write(`id: ${id}\nevent: order.created\ndata: {"id":${id}}\n\n`)
      }
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ id }))
      return
    }
    if (url.pathname === '/feed') {
      // Six events in all; each connection sends the next three after Last-Event-ID, then ends.
      const after = Number(req.headers['last-event-id'] ?? 0)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (let id = after + 1; id <= Math.min(after + 3, 6); id++) {
        res.write(`id: ${id}\ndata: {"n":${id}}\n\n`)
      }
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const collection = (doc: unknown): Collection => CollectionSchema.parse(doc)

const failures = (results: RunResult[]) =>
  results.flatMap((r) => [
    ...(r.error ? [`${r.item.name}: ${r.error.message}`] : []),
    ...r.assertions.filter((a) => a.status === 'fail').map((a) => `${r.item.name}: ${a.name}`)
  ])

describe('a connection across steps', () => {
  it('holds what arrives after the step that opened it, for the step that reads it', async () => {
    const summary = await runSuite({
      collection: collection({
        id: 'orders',
        steps: [
          {
            name: 'watch orders',
            GET: `${origin}/orders/events`,
            connection: 'orders',
            // Subscribed before anything is ordered: nothing is missed.
            settings: { untilEvent: 'subscribed' },
            tests: "gta.expectResponseBodyToHaveProperty('[0].data.topic', 'orders')"
          },
          {
            name: 'place order',
            POST: `${origin}/orders`,
            tests:
              "gta.expectResponseBodyToHaveProperty('id', 'orderId', 'setAsCollectionVariable')"
          },
          {
            name: 'order created',
            connection: 'orders',
            settings: { untilEvent: 'order.created', streamTimeout: 5000 },
            tests: [
              'gta.expectResponseStatusCodeToBe(200)',
              "gta.expectResponseBodyToHaveProperty('[0].event', 'order.created')",
              "gta.test('the order placed', () => assert.equal(res.body[0].data.id, Number(gta.get('orderId'))))",
              "gta.test('read from the open connection', () => assert.deepEqual(res.stream.connection, { name: 'orders', open: true }))"
            ].join('\n')
          }
        ]
      })
    })
    expect(failures(summary.results)).toEqual([])
    const [opened, , read] = summary.results
    expect(opened!.response?.stream).toMatchObject({
      endedBy: 'untilEvent',
      connection: { name: 'orders', open: true }
    })
    // The reading step shows the request that opened the stream.
    expect(read!.request.url).toBe(`${origin}/orders/events`)
    // The run's end closes it.
    await streamClosed
  })

  it('takes what is already held when a reading step waits for nothing', async () => {
    const changes: ConnectionState[][] = []
    const connections = new Connections((state) => changes.push(state))
    const summary = await runSuite({
      connections,
      collection: collection({
        id: 'orders',
        steps: [
          { GET: `${origin}/orders/events`, connection: 'orders' },
          { POST: `${origin}/orders` },
          { POST: `${origin}/orders` },
          { connection: 'orders', settings: { maxEvents: 3 } },
          { connection: 'orders' }
        ]
      })
    })
    expect(failures(summary.results)).toEqual([])
    const ends = summary.results.map((r) => r.response?.stream?.endedBy)
    expect(ends).toEqual(['held', undefined, undefined, 'maxEvents', 'held'])
    expect(summary.results[3]!.response?.body).toContain('event: subscribed')
    expect(summary.results[4]!.response?.body).toBe('')
    // Kept by the caller, still open after the run, with nothing held.
    expect(connections.state()).toEqual([{ name: 'orders', held: 0, open: true }])
    expect(changes.length).toBeGreaterThan(1)
    connections.close()
    expect(connections.state()).toEqual([])
    await streamClosed
  })

  it('reports a connection that is not open, without sending anything', async () => {
    const summary = await runSuite({
      collection: collection({
        id: 'orders',
        steps: [{ name: 'too soon', connection: 'orders' }]
      })
    })
    const [result] = summary.results
    expect(result!.status).toBe('error')
    expect(result!.error).toMatchObject({ phase: 'connection' })
    expect(result!.error?.message).toContain('No connection named orders is open')
    expect(result!.request).toMatchObject({ method: 'READ', url: 'orders' })
  })

  it('lets setup open a connection every data row reads', async () => {
    const summary = await runSuite({
      collection: collection({
        id: 'orders',
        setup: [
          {
            GET: `${origin}/orders/events`,
            connection: 'orders',
            settings: { untilEvent: 'subscribed' }
          }
        ],
        steps: [
          { POST: `${origin}/orders` },
          {
            connection: 'orders',
            settings: { untilEvent: 'order.created', streamTimeout: 5000 }
          }
        ]
      }),
      rows: [
        { source: 'row 1', vars: {}, label: null },
        { source: 'row 2', vars: {}, label: null }
      ]
    })
    expect(failures(summary.results)).toEqual([])
    const reads = summary.results.filter((r) => r.request.method === 'GET' && r.stage !== 'setup')
    expect(reads.map((r) => r.response?.stream?.at.length)).toEqual([1, 1])
  })

  it('reads what a connection held after the server closed it, then reports it closed', async () => {
    const summary = await runSuite({
      collection: collection({
        id: 'feed',
        steps: [
          { GET: `${origin}/feed`, connection: 'feed', settings: { maxEvents: 1 } },
          { connection: 'feed', settings: { streamTimeout: 2000 } }
        ]
      })
    })
    expect(failures(summary.results)).toEqual([])
    const read = summary.results[1]!
    expect(read.response?.stream).toMatchObject({
      endedBy: 'close',
      connection: { name: 'feed', open: false }
    })
    expect(read.response?.body).toBe('id: 2\ndata: {"n":2}\n\nid: 3\ndata: {"n":3}\n\n')
  })

  it('resumes a stream in a later step that sends the last id as Last-Event-ID', async () => {
    const summary = await runSuite({
      collection: collection({
        id: 'feed',
        steps: [
          {
            name: 'first part',
            GET: `${origin}/feed`,
            tests: "gta.set('lastId', res.body.at(-1).id)"
          },
          {
            name: 'resume',
            GET: `${origin}/feed`,
            headers: { 'Last-Event-ID': '{{lastId}}' },
            tests: [
              "gta.expectResponseBodyToHaveProperty('[0].id', '4')",
              "gta.expectResponseBodyToHaveProperty('[2].data.n', 6)"
            ].join('\n')
          }
        ]
      })
    })
    expect(failures(summary.results)).toEqual([])
    expect(summary.results[1]!.request.headers).toContainEqual({
      name: 'Last-Event-ID',
      value: '3'
    })
  })
})
