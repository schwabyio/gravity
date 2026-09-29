import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema } from '../model/documents.js'
import { runCollection } from './runCollection.js'

let server: http.Server
let origin: string
let seen: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.url ?? '')
    if (req.url?.startsWith('/fail')) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end('{"error":true}')
      return
    }
    if (req.url?.startsWith('/slow')) {
      setTimeout(() => {
        res.writeHead(200)
        res.end('late')
      }, 3_000)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const collection = (...urls: string[]) =>
  CollectionSchema.parse({
    id: 'suite',
    steps: urls.map((url, index) => ({ name: `step-${index + 1}`, GET: url }))
  })

describe('runCollection', () => {
  it('runs every step in list order', async () => {
    seen = []
    const summary = await runCollection({
      collection: collection(`${origin}/a`, `${origin}/b`, `${origin}/c`)
    })
    expect(seen).toEqual(['/a', '/b', '/c'])
    expect(summary.total).toBe(3)
    expect(summary.passed).toBe(3)
    expect(summary.skipped).toBe(0)
    expect(summary.results.map((r) => r.item.name)).toEqual(['step-1', 'step-2', 'step-3'])
  })

  it('reports each result as it lands, not only at the end', async () => {
    const seenIndexes: number[] = []
    await runCollection({
      collection: collection(`${origin}/a`, `${origin}/b`),
      onResult: (index) => seenIndexes.push(index)
    })
    expect(seenIndexes).toEqual([0, 1])
  })

  it('keeps going past a failure by default', async () => {
    seen = []
    const summary = await runCollection({
      collection: collection(`${origin}/a`, `http://127.0.0.1:1/down`, `${origin}/c`)
    })
    expect(seen).toEqual(['/a', '/c'])
    expect(summary.errored).toBe(1)
    expect(summary.passed).toBe(2)
    expect(summary.skipped).toBe(0)
  })

  it('stops at the first failure when told to bail', async () => {
    seen = []
    const summary = await runCollection({
      collection: collection(`${origin}/a`, `http://127.0.0.1:1/down`, `${origin}/c`),
      bail: true
    })
    expect(seen).toEqual(['/a'])
    expect(summary.skipped).toBe(1)
    expect(summary.results).toHaveLength(2)
  })

  it('shares one variable scope across the run', async () => {
    // A value set once at the collection level is visible to every step; each
    // step also re-applies it, which is what SPEC.md documents.
    const summary = await runCollection({
      collection: CollectionSchema.parse({
        before: { script: "gta.set('path', 'shared')" },
        steps: [{ GET: `${origin}/{{path}}` }, { GET: `${origin}/{{path}}-again` }]
      })
    })
    expect(summary.passed).toBe(2)
    expect(summary.results.map((r) => r.request.url)).toEqual([
      `${origin}/shared`,
      `${origin}/shared-again`
    ])
  })

  it('applies the collection headers to every step', async () => {
    const summary = await runCollection({
      collection: CollectionSchema.parse({
        headers: { 'X-Suite': 'yes' },
        steps: [{ GET: `${origin}/a` }, { GET: `${origin}/b` }]
      })
    })
    for (const result of summary.results) {
      expect(result.request.headers).toContainEqual({ name: 'X-Suite', value: 'yes' })
    }
  })

  it('stops when cancelled, leaving the rest skipped', async () => {
    const controller = new AbortController()
    const pending = runCollection({
      collection: collection(`${origin}/slow`, `${origin}/b`, `${origin}/c`),
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 50)
    const summary = await pending
    expect(summary.skipped).toBeGreaterThan(0)
    expect(summary.passed).toBe(0)
  })

  it('handles a collection with no steps', async () => {
    const summary = await runCollection({ collection: CollectionSchema.parse({ steps: [] }) })
    expect(summary).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0, results: [] })
  })
})
