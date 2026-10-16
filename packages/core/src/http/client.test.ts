import fs from 'node:fs'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyBody, readConnection, sendHttpRequest, statusTextFor } from './client.js'
import {
  EVENT_STREAM_LIMITS,
  type ConnectedStream,
  type OpenStream,
  type StreamWatch
} from './stream.js'
import { bodyAsObject } from '../model/bodyObject.js'
import type { SentRequest, StreamClosed } from '../model/run.js'

let server: http.Server
let origin: string

/** A PNG's signature and the start of its header: bytes that are not UTF-8. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])

const get = (path: string): SentRequest => ({
  method: 'GET',
  url: `${origin}${path}`,
  headers: [],
  body: null
})

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', origin || 'http://localhost')
    switch (url.pathname) {
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', echoHeader: req.headers['x-probe'] ?? null }))
        return
      case '/empty':
        res.writeHead(204)
        res.end()
        return
      case '/png':
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(PNG)
        return
      case '/jwt':
        res.writeHead(200, { 'content-type': 'application/jwt' })
        res.end('eyJhbGciOiJub25lIn0.e30.')
        return
      case '/slow':
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/plain' })
          res.end('late')
        }, 300)
        return
      case '/redirect':
        res.writeHead(302, { location: '/json' })
        res.end()
        return
      case '/hangup':
        // Closes the connection with no answer, as a server that crashed or timed out would.
        setTimeout(() => req.socket.destroy(), 200)
        return
      case '/echo': {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({ method: req.method, contentType: req.headers['content-type'], body })
          )
        })
        return
      }
      default:
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('nope')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('sendHttpRequest', () => {
  it('returns status, headers, body and timings', async () => {
    const outcome = await sendHttpRequest(get('/json'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(200)
    expect(outcome.response.statusText).toBe('OK')
    expect(outcome.response.bodyKind).toBe('json')
    expect(JSON.parse(outcome.response.body).status).toBe('ok')
    expect(outcome.response.sizeBytes).toBeGreaterThan(0)
    expect(outcome.response.timings.ttfbMs).toBeGreaterThanOrEqual(0)
    expect(outcome.response.timings.totalMs).toBeGreaterThanOrEqual(outcome.response.timings.ttfbMs)
  })

  it('sends request headers', async () => {
    const outcome = await sendHttpRequest({
      ...get('/json'),
      headers: [{ name: 'X-Probe', value: 'yes' }]
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(JSON.parse(outcome.response.body).echoHeader).toBe('yes')
  })

  it('handles a 204 with no body', async () => {
    const outcome = await sendHttpRequest(get('/empty'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(204)
    expect(outcome.response.body).toBe('')
    expect(outcome.response.bodyKind).toBe('empty')
  })

  it('keeps a binary body whose bytes are not text as base64, and one that is text as text', async () => {
    const png = await sendHttpRequest(get('/png'))
    if (!png.ok) throw new Error('no response')
    expect(png.response.bodyKind).toBe('binary')
    expect(png.response.bodyEncoding).toBe('base64')
    expect(Buffer.from(png.response.body, 'base64').equals(PNG)).toBe(true)
    expect(png.response.sizeBytes).toBe(PNG.length)

    const jwt = await sendHttpRequest(get('/jwt'))
    if (!jwt.ok) throw new Error('no response')
    expect(jwt.response.bodyKind).toBe('binary')
    expect(jwt.response.bodyEncoding).toBeUndefined()
    expect(jwt.response.body).toBe('eyJhbGciOiJub25lIn0.e30.')
  })

  it('reports a non-2xx as a normal response rather than a failure', async () => {
    const outcome = await sendHttpRequest(get('/missing'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(404)
    expect(outcome.response.statusText).toBe('Not Found')
  })

  it('follows redirects when settings allow and reports the count', async () => {
    const outcome = await sendHttpRequest(get('/redirect'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(200)
    expect(outcome.response.redirectCount).toBe(1)
    expect(outcome.response.url).toBe(`${origin}/json`)
  })

  it('stops at the redirect when following is turned off', async () => {
    const outcome = await sendHttpRequest(get('/redirect'), {
      settings: { followRedirects: false }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(302)
  })

  it('honours settings.timeout', async () => {
    const outcome = await sendHttpRequest(get('/slow'), { settings: { timeout: 50 } })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.message).toContain('timed out')
    expect(outcome.error.code).toBe('ETIMEDOUT')
    expect(outcome.error.elapsedMs).toBeGreaterThanOrEqual(45)
  })

  it('treats settings.timeout of 0 as no limit', async () => {
    const outcome = await sendHttpRequest(get('/slow'), { settings: { timeout: 0 } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.body).toBe('late')
  })

  it('reports an abort without throwing', async () => {
    const controller = new AbortController()
    const pending = sendHttpRequest(get('/slow'), { signal: controller.signal })
    controller.abort()
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('ABORTED')
  })

  it('reports a connection failure as an error, keeping the attempted request', async () => {
    const outcome = await sendHttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:1/nothing',
      headers: [],
      body: null
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.request.url).toBe('http://127.0.0.1:1/nothing')
    expect(outcome.error.message).toBeTruthy()
    // Nothing was sent, so there is no connection to describe.
    expect(outcome.error.httpVersion).toBeUndefined()
    expect(outcome.error.connectionReused).toBeUndefined()
  })

  it('says how long a connection went before it closed with no answer', async () => {
    const outcome = await sendHttpRequest(get('/hangup'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatchObject({
      message: 'other side closed',
      code: 'UND_ERR_SOCKET',
      httpVersion: 'HTTP/1.1'
    })
    expect(outcome.error.elapsedMs).toBeGreaterThanOrEqual(190)
    expect(outcome.error.elapsedMs).toBeLessThan(2000)
  })

  it('says whether a request went on a new connection or a reused one', async () => {
    // Its own server, so no earlier test's connections are in the pool.
    const fresh = http.createServer((req, res) => {
      if (req.url === '/hangup') req.socket.destroy()
      else res.end('ok')
    })
    await new Promise<void>((resolve) => fresh.listen(0, '127.0.0.1', resolve))
    const at = (path: string) => ({
      ...get(path),
      url: `http://127.0.0.1:${(fresh.address() as AddressInfo).port}${path}`
    })
    // undici frees a connection for the next request once the last one's response is done with.
    const settle = () => new Promise((resolve) => setImmediate(resolve))
    try {
      const first = await sendHttpRequest(at('/'))
      await settle()
      const second = await sendHttpRequest(at('/'))
      expect(first.ok && first.response).toMatchObject({
        httpVersion: 'HTTP/1.1',
        connectionReused: false
      })
      expect(second.ok && second.response).toMatchObject({ connectionReused: true })
      // Dropped on a connection kept from before: where an idle connection the server closed shows.
      await settle()
      const dropped = await sendHttpRequest(at('/hangup'))
      expect(!dropped.ok && dropped.error).toMatchObject({
        code: 'UND_ERR_SOCKET',
        connectionReused: true
      })
      // That connection is gone, so the next drop is on a new one.
      const again = await sendHttpRequest(at('/hangup'))
      expect(!again.ok && again.error).toMatchObject({ connectionReused: false })
    } finally {
      fresh.closeAllConnections()
      await new Promise<void>((resolve) => fresh.close(() => resolve()))
    }
  })

  it('traces only its own requests, not those of Node’s fetch on the same channels', async () => {
    await fetch(`${origin}/json`).then((res) => res.text())
    const outcome = await sendHttpRequest(get('/json'))
    expect(outcome.ok && outcome.response.httpVersion).toBe('HTTP/1.1')
  })

  it('sends a body', async () => {
    const outcome = await sendHttpRequest({
      method: 'POST',
      url: `${origin}/echo`,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: '{"a":1}'
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const echoed = JSON.parse(outcome.response.body)
    expect(echoed.method).toBe('POST')
    expect(echoed.contentType).toBe('application/json')
    expect(echoed.body).toBe('{"a":1}')
  })
})

describe('sendHttpRequest over TLS', () => {
  const TLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/tls')
  const ca = fs.readFileSync(path.join(TLS, 'ca.pem'), 'utf8')
  let secure: https.Server
  let secureOrigin: string

  beforeAll(async () => {
    // A server whose certificate a local CA signed: trusted only when told to be.
    secure = https.createServer(
      {
        cert: fs.readFileSync(path.join(TLS, 'server.pem')),
        key: fs.readFileSync(path.join(TLS, 'server-key.pem'))
      },
      (req, res) => {
        if (req.url === '/redirect') {
          res.writeHead(302, { location: '/ok' })
          res.end()
          return
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('secure')
      }
    )
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
    secureOrigin = `https://localhost:${(secure.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    secure.closeAllConnections()
    await new Promise<void>((resolve) => secure.close(() => resolve()))
  })

  const secureGet = (path: string): SentRequest => ({
    method: 'GET',
    url: `${secureOrigin}${path}`,
    headers: [],
    body: null
  })

  it('refuses a certificate from a CA it does not trust, and says what to do', async () => {
    const outcome = await sendHttpRequest(secureGet('/ok'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    expect(outcome.error.message).toContain('tls.ca in project.yml')
    // Node's own advice is already taken: the system's CAs are always trusted.
    expect(outcome.error.message).not.toContain('--use-system-ca')
  })

  it('trusts the server once its CA is given', async () => {
    const outcome = await sendHttpRequest(secureGet('/ok'), { ca: [ca] })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.status).toBe(200)
    expect(outcome.response.body).toBe('secure')
  })

  it('trusts it whether or not redirects are followed', async () => {
    const followed = await sendHttpRequest(secureGet('/redirect'), { ca: [ca] })
    expect(followed.ok && followed.response.status).toBe(200)
    expect(followed.ok && followed.response.redirectCount).toBe(1)

    const stopped = await sendHttpRequest(secureGet('/redirect'), {
      ca: [ca],
      settings: { followRedirects: false }
    })
    expect(stopped.ok && stopped.response.status).toBe(302)
  })
})

describe('classifyBody', () => {
  it('trusts the content type', () => {
    expect(classifyBody('application/json; charset=utf-8', '{}')).toBe('json')
    expect(classifyBody('application/problem+json', '{}')).toBe('json')
    expect(classifyBody('text/xml', '<a/>')).toBe('xml')
    expect(classifyBody('text/html', '<html>')).toBe('html')
    expect(classifyBody('text/plain', 'hi')).toBe('text')
    expect(classifyBody('image/png', 'binary-ish')).toBe('binary')
    expect(classifyBody('text/event-stream', 'data: 1\n\n')).toBe('events')
  })

  it('falls back to the body shape when the type says nothing useful', () => {
    expect(classifyBody(undefined, '{"a":1}')).toBe('json')
    expect(classifyBody(undefined, '[1,2]')).toBe('json')
    expect(classifyBody(undefined, '<a/>')).toBe('xml')
    expect(classifyBody(undefined, 'plain')).toBe('text')
  })

  it('reports an empty body as empty', () => {
    expect(classifyBody('application/json', '')).toBe('empty')
  })
})

describe('statusTextFor', () => {
  it('names known statuses and classes unknown ones', () => {
    expect(statusTextFor(201)).toBe('Created')
    expect(statusTextFor(418)).toBe('Client Error')
    expect(statusTextFor(599)).toBe('Server Error')
  })
})

describe('sendHttpRequest with an event stream', () => {
  let events: http.Server
  let eventsOrigin: string
  /** Resolved when the server sees the client close an open stream. */
  let closed: Promise<void>

  const SSE = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }

  beforeAll(async () => {
    events = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      switch (url.pathname) {
        case '/closed':
          res.writeHead(200, SSE)
          res.write('event: subscribed\ndata: {"symbol":"ACME"}\n\n')
          res.write(': heartbeat\n\n')
          res.write('id: 41\nevent: price\ndata: {"price":100}\n\n')
          res.end('data: [DONE]\n\n')
          return
        case '/open': {
          // One event now and one every 20ms, until the client goes.
          res.writeHead(200, SSE)
          let n = 0
          const send = () => res.write(`id: ${++n}\ndata: {"n":${n}}\n\n`)
          send()
          const every = setInterval(send, 20)
          closed = new Promise((resolve) =>
            res.on('close', () => {
              clearInterval(every)
              resolve()
            })
          )
          return
        }
        case '/quiet':
          res.writeHead(200, SSE)
          res.write('data: only\n\n')
          return
        case '/named':
          res.writeHead(200, SSE)
          res.write('event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\n')
          res.write('event: done\ndata: 3\n\nevent: tick\ndata: 4\n\n')
          return
        case '/drop':
          // One event, then the connection goes without the stream ending.
          res.writeHead(200, SSE)
          res.write('data: 1\n\n', () => setTimeout(() => res.socket?.destroy(), 20))
          return
        case '/pings':
          // A comment to open with, as some servers send, then heartbeats, an event and the end.
          res.writeHead(200, SSE)
          res.write(':ok\n\n')
          res.write(': ping\n\n: ping\n\n')
          res.end('data: 1\n\n: ping\n\n')
          return
        case '/late':
          setTimeout(() => {
            res.writeHead(200, SSE)
            res.end('data: late\n\n')
          }, 300)
          return
        case '/flood':
          res.writeHead(200, SSE)
          res.write(Array.from({ length: 1005 }, (_, i) => `data: ${i}\n\n`).join(''))
          return
        case '/pieces': {
          // CRLFs and a two-byte character split between writes.
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
          const bytes = Buffer.from('data: café\r\n\r\ndata: 2\r\n\r\n')
          const cuts = [9, 11, 25]
          let from = 0
          const next = () => {
            const to = cuts.shift() ?? bytes.length
            res.write(bytes.subarray(from, to))
            from = to
            if (from < bytes.length) setTimeout(next, 5)
            else res.end()
          }
          next()
          return
        }
        default:
          res.writeHead(404)
          res.end()
      }
    })
    await new Promise<void>((resolve) => events.listen(0, '127.0.0.1', resolve))
    eventsOrigin = `http://127.0.0.1:${(events.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    events.closeAllConnections()
    await new Promise<void>((resolve) => events.close(() => resolve()))
  })

  const stream = (path: string, method = 'GET'): SentRequest => ({
    method,
    url: `${eventsOrigin}${path}`,
    headers: [{ name: 'Accept', value: 'text/event-stream' }],
    body: null
  })

  it('reads a stream the server closes, keeping its text as received', async () => {
    const outcome = await sendHttpRequest(stream('/closed'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { response } = outcome
    expect(response.status).toBe(200)
    expect(response.bodyKind).toBe('events')
    expect(response.body).toBe(
      'event: subscribed\ndata: {"symbol":"ACME"}\n\n: heartbeat\n\nid: 41\nevent: price\ndata: {"price":100}\n\ndata: [DONE]\n\n'
    )
    expect(bodyAsObject(response)).toEqual({
      ok: true,
      body: [
        { event: 'subscribed', data: { symbol: 'ACME' } },
        { event: 'price', id: '41', data: { price: 100 } },
        { data: '[DONE]' }
      ]
    })
    expect(response.stream?.endedBy).toBe('close')
    expect(response.stream?.at).toHaveLength(3)
    expect(response.sizeBytes).toBe(Buffer.byteLength(response.body))
  })

  it('stops at maxEvents, ending the body with the last one, and closes the connection', async () => {
    const outcome = await sendHttpRequest(stream('/open'), { settings: { maxEvents: 3 } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const { response } = outcome
    expect(response.stream?.endedBy).toBe('maxEvents')
    expect(response.body).toBe(
      'id: 1\ndata: {"n":1}\n\nid: 2\ndata: {"n":2}\n\nid: 3\ndata: {"n":3}\n\n'
    )
    const at = response.stream!.at
    expect(at).toHaveLength(3)
    expect(at[0]).toBeGreaterThanOrEqual(0)
    expect(at[2]).toBeGreaterThan(at[0]!)
    await closed
  })

  it('stops streamTimeout milliseconds after the headers, keeping what came', async () => {
    const outcome = await sendHttpRequest(stream('/quiet'), { settings: { streamTimeout: 100 } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.stream?.endedBy).toBe('streamTimeout')
    expect(outcome.response.body).toBe('data: only\n\n')
    expect(
      outcome.response.timings.totalMs - outcome.response.timings.ttfbMs
    ).toBeGreaterThanOrEqual(95)
  })

  it('lets settings.timeout cover only the wait for the headers', async () => {
    // Five events, one every 20ms, take longer than the timeout.
    const read = await sendHttpRequest(stream('/open'), {
      settings: { timeout: 50, maxEvents: 5 }
    })
    expect(read.ok && read.response.stream).toMatchObject({ endedBy: 'maxEvents' })

    const late = await sendHttpRequest(stream('/late'), { settings: { timeout: 50 } })
    expect(late.ok).toBe(false)
    if (late.ok) return
    expect(late.error.message).toBe('Request timed out after 50ms')
  })

  it('stops at the safety limit, with no maxEvents or one above it', async () => {
    for (const maxEvents of [0, 5000]) {
      const outcome = await sendHttpRequest(stream('/flood'), { settings: { maxEvents } })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.response.stream?.endedBy).toBe('limit')
      expect(outcome.response.stream?.at).toHaveLength(EVENT_STREAM_LIMITS.events)
      expect(outcome.response.body.endsWith('data: 999\n\n')).toBe(true)
    }
  })

  it('reads lines and characters split between chunks', async () => {
    const outcome = await sendHttpRequest(stream('/pieces'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.body).toBe('data: café\r\n\r\ndata: 2\r\n\r\n')
    expect(bodyAsObject(outcome.response)).toEqual({
      ok: true,
      body: [{ data: 'café' }, { data: 2 }]
    })
  })

  it('reports a Cancel during the stream as cancelled, as for any request', async () => {
    const controller = new AbortController()
    const pending = sendHttpRequest(stream('/open'), { signal: controller.signal })
    setTimeout(() => controller.abort(), 60)
    const outcome = await pending
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('ABORTED')
    await closed
  })

  it('stops after the first event untilEvent names, ending the body with it', async () => {
    const outcome = await sendHttpRequest(stream('/named'), { settings: { untilEvent: 'done' } })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.stream?.endedBy).toBe('untilEvent')
    expect(outcome.response.body).toBe(
      'event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\nevent: done\ndata: 3\n\n'
    )
  })

  it('tells a watcher of the stream and each event, and its Stop ends the reading', async () => {
    const stopping = new AbortController()
    const seen: unknown[] = []
    const opened: unknown[] = []
    const outcome = await sendHttpRequest(stream('/open'), {
      watch: {
        open: (head) => {
          opened.push(head)
          return stopping.signal
        },
        event: (event) => {
          seen.push(event)
          if (seen.length === 2) stopping.abort()
        }
      }
    })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(opened).toEqual([{ status: 200, statusText: 'OK' }])
    expect(seen).toEqual([
      { id: '1', data: { n: 1 } },
      { id: '2', data: { n: 2 } }
    ])
    expect(outcome.response.stream?.endedBy).toBe('stopped')
    expect(outcome.response.stream?.at).toHaveLength(2)
    await closed
  })

  it('hands a stream it keeps over open, having read only what its settings ask', async () => {
    const kept: OpenStream[] = []
    const outcome = await sendHttpRequest(stream('/named'), { keep: (s) => kept.push(s) })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // With nothing to wait for, the step reads none: the events are the connection's.
    expect(outcome.response.stream).toEqual({ endedBy: 'held', at: [] })
    expect(kept).toHaveLength(1)
    const read = await readConnection(kept[0]!, { settings: { maxEvents: 3 } })
    expect(read.ok && read.response.stream?.endedBy).toBe('maxEvents')
    expect(read.ok && read.response.body).toBe(
      'event: tick\ndata: 1\n\nevent: tick\ndata: 2\n\nevent: done\ndata: 3\n\n'
    )
    expect(read.ok && read.response.status).toBe(200)
    kept[0]!.close()
  })

  it('tells a watcher of each connection it opens, and how and when each closed', async () => {
    const heard: Array<{ stream: ConnectedStream; closed: Promise<StreamClosed> }> = []
    const watch: StreamWatch = { connected: (stream, closed) => heard.push({ stream, closed }) }
    const closing = async (at: number) => heard[at]!.closed

    await sendHttpRequest(stream('/closed'), { watch })
    expect(heard[0]!.stream).toEqual({
      request: stream('/closed'),
      status: 200,
      statusText: 'OK'
    })
    expect(await closing(0)).toEqual({
      by: 'server',
      events: 3,
      heartbeats: 1,
      openMs: expect.any(Number),
      silentMs: expect.any(Number)
    })

    // A step done reading closes it, saying how its reading stopped.
    await sendHttpRequest(stream('/open'), { watch, settings: { maxEvents: 2 } })
    expect(await closing(1)).toMatchObject({ by: 'app', reason: 'maxEvents' })
    expect((await closing(1)).events).toBeGreaterThanOrEqual(2)

    await sendHttpRequest(stream('/flood'), { watch })
    expect(await closing(2)).toMatchObject({ by: 'limit' })
    expect((await closing(2)).events).toBeGreaterThanOrEqual(EVENT_STREAM_LIMITS.events)

    const dropped = await sendHttpRequest(stream('/drop'), { watch })
    expect(dropped.ok).toBe(false)
    expect(await closing(3)).toMatchObject({ by: 'error', message: expect.any(String), events: 1 })

    // One kept for later steps is named, and stays open until it is closed.
    const kept: OpenStream[] = []
    await sendHttpRequest(stream('/quiet'), {
      watch,
      connection: 'prices',
      keep: (s) => kept.push(s)
    })
    expect(heard[4]!.stream.connection).toBe('prices')
    let settled = false
    void heard[4]!.closed.then(() => (settled = true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)
    kept[0]!.close('reset')
    const closed = await closing(4)
    expect(closed).toMatchObject({ by: 'app', reason: 'reset', events: 1, heartbeats: 0 })
    expect(closed.openMs).toBeGreaterThanOrEqual(45)
    // Its one event came with the headers, and nothing since.
    expect(closed.silentMs).toBeGreaterThanOrEqual(45)

    // A Cancel while the step reads closes it as cancelled.
    const controller = new AbortController()
    const cancelled = sendHttpRequest(stream('/open'), { watch, signal: controller.signal })
    setTimeout(() => controller.abort(), 60)
    expect((await cancelled).ok).toBe(false)
    expect(await closing(5)).toMatchObject({ by: 'app', reason: 'cancelled' })

    // Heartbeats are counted apart from the events; the end is what it heard last.
    await sendHttpRequest(stream('/pings'), { watch })
    const pinged = await closing(6)
    expect(pinged).toMatchObject({ by: 'server', events: 1, heartbeats: 4 })
    expect(pinged.silentMs).toBeLessThan(pinged.openMs + 1)
    expect(heard).toHaveLength(7)
  })

  it('reads a HEAD response as having no body', async () => {
    const outcome = await sendHttpRequest(stream('/closed', 'HEAD'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.response.bodyKind).toBe('empty')
    expect(outcome.response.stream).toBeUndefined()
  })
})

describe('sendHttpRequest and HTTP versions', () => {
  const TLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../test-fixtures/tls')
  const ca = [fs.readFileSync(path.join(TLS, 'ca.pem'), 'utf8')]
  const cert = {
    cert: fs.readFileSync(path.join(TLS, 'server.pem')),
    key: fs.readFileSync(path.join(TLS, 'server-key.pem'))
  }
  const servers: Array<http.Server | http2.Http2Server> = []
  /** Answers with the version the server saw, and for /redirect, points at /. */
  const answer = (
    req: { url?: string; httpVersion: string },
    res: {
      writeHead(status: number, headers: Record<string, string>): unknown
      end(body: string): unknown
    }
  ) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/' })
      res.end('')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(req.httpVersion)
  }
  const listen = async (server: http.Server | http2.Http2Server, scheme: string) => {
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    return `${scheme}://localhost:${(server.address() as AddressInfo).port}`
  }
  /** Speaks HTTP/2 or HTTP/1.1 over TLS, as most servers do: HTTP/2 when the client offers it. */
  let both: string
  /** HTTP/1.1 over TLS only. */
  let older: string
  /** HTTP/2 in the clear, from the start: h2c. */
  let cleartext: string

  beforeAll(async () => {
    both = await listen(http2.createSecureServer({ ...cert, allowHTTP1: true }, answer), 'https')
    older = await listen(https.createServer(cert, answer), 'https')
    cleartext = await listen(http2.createServer(answer), 'http')
  })

  afterAll(async () => {
    for (const server of servers) {
      if ('closeAllConnections' in server) server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  const send = (url: string, httpVersion?: 'auto' | 1.1 | 2) =>
    sendHttpRequest(
      { method: 'GET', url, headers: [], body: null },
      { ca, ...(httpVersion !== undefined ? { settings: { httpVersion } } : {}) }
    )

  it('uses HTTP/2 when an https server picks it, by default, and says so', async () => {
    const outcome = await send(`${both}/`)
    expect(outcome.ok && outcome.response).toMatchObject({ body: '2.0', httpVersion: 'HTTP/2' })
    const older1 = await send(`${older}/`)
    expect(older1.ok && older1.response).toMatchObject({ body: '1.1', httpVersion: 'HTTP/1.1' })
  })

  it('never offers HTTP/2 with httpVersion 1.1', async () => {
    const outcome = await send(`${both}/`, 1.1)
    expect(outcome.ok && outcome.response).toMatchObject({ body: '1.1', httpVersion: 'HTTP/1.1' })
  })

  it('insists on HTTP/2 with httpVersion 2, failing on a server that will not', async () => {
    const outcome = await send(`${both}/`, 2)
    expect(outcome.ok && outcome.response).toMatchObject({ body: '2.0', httpVersion: 'HTTP/2' })

    const refused = await send(`${older}/`, 2)
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.error.code).toBe('NO_HTTP2')
    expect(refused.error.message).toBe(
      'localhost answered with HTTP/1.1, not HTTP/2, and httpVersion is 2'
    )
  })

  it('speaks HTTP/2 in the clear to an http:// URL only with httpVersion 2', async () => {
    const h2c = await send(`${cleartext}/`, 2)
    expect(h2c.ok && h2c.response).toMatchObject({ body: '2.0', httpVersion: 'HTTP/2' })
    const auto = await send(`${cleartext}/`)
    expect(auto.ok).toBe(false)
  })

  it('traces the last request of a redirect, sent on the connection the first opened', async () => {
    const outcome = await send(`${both}/redirect`, 2)
    expect(outcome.ok && outcome.response).toMatchObject({
      redirectCount: 1,
      httpVersion: 'HTTP/2',
      connectionReused: true
    })
  })
})
