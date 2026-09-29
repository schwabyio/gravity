import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { classifyBody, sendHttpRequest, statusTextFor } from './client.js'
import type { SentRequest } from '../model/run.js'

let server: http.Server
let origin: string

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
