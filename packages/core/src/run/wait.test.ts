import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CollectionSchema,
  MAX_WAIT_MS,
  StepSchema,
  stepLabel,
  stepMethod,
  waitText
} from '../model/documents.js'
import { resultName, type RunResult } from '../model/run.js'
import { endpointProblem } from '../workspace/library.js'
import { runRequest } from './runRequest.js'
import { runSuite } from './runSuite.js'

let tmp: string
let collectionPath: string
let server: http.Server
let origin: string
let seen: string[] = []

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-wait-')))
  await fs.mkdir(path.join(tmp, 'collections'))
  await fs.mkdir(path.join(tmp, 'requests'))
  collectionPath = path.join(tmp, 'collections', 'orders.yml')
  // Reusable requests that end with a wait, and some that only wait.
  await fs.writeFile(
    path.join(tmp, 'requests', 'create-then-settle.yml'),
    [
      'id: create-then-settle',
      'params:',
      '  settle: 10',
      'steps:',
      '  - name: create',
      `    POST: "${origin}/orders"`,
      "  - wait: '{{params.settle}}'",
      ''
    ].join('\n')
  )
  await fs.writeFile(
    path.join(tmp, 'requests', 'pause.yml'),
    ['id: pause', 'params: {}', 'steps:', '  - wait: 10', ''].join('\n')
  )
  // A file whose wait comes first, before anything has asked for its params.
  await fs.writeFile(
    path.join(tmp, 'requests', 'settle-then-read.yml'),
    [
      'id: settle-then-read',
      'params:',
      '  ms: { required: true }',
      'steps:',
      "  - wait: '{{params.ms}}'",
      '  - name: read',
      `    GET: "${origin}/orders/1"`,
      ''
    ].join('\n')
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmp, { recursive: true, force: true })
})

async function suite(
  doc: Record<string, unknown>,
  options: { signal?: AbortSignal; onResult?: (result: RunResult) => void } = {}
) {
  seen = []
  const collection = CollectionSchema.parse({ id: 'orders', ...doc })
  const reported: RunResult[] = []
  const summary = await runSuite({
    collection,
    collectionPath,
    context: {
      collectionPath,
      env: {},
      dataRow: null,
      collectionVars: collection.vars ?? null
    },
    rows: null,
    ...(options.signal ? { signal: options.signal } : {}),
    onResult: (_index, result) => {
      reported.push(result)
      options.onResult?.(result)
    }
  })
  return { summary, reported, names: summary.results.map(resultName) }
}

describe('a wait step', () => {
  it('is written as wait: and milliseconds, or a {{variable}} holding them', () => {
    expect(StepSchema.parse({ wait: 2000 })).toEqual({ wait: 2000 })
    expect(StepSchema.parse({ wait: 0 })).toEqual({ wait: 0 })
    expect(StepSchema.parse({ wait: MAX_WAIT_MS })).toEqual({ wait: MAX_WAIT_MS })
    expect(StepSchema.parse({ wait: '{{pause}}' })).toEqual({ wait: '{{pause}}' })
    const full = {
      name: 'let the index catch up',
      wait: 1500,
      docs: 'Search is updated a moment after a write.',
      flags: { search: true },
      tags: ['slow']
    }
    expect(StepSchema.parse(full)).toEqual(full)
  })

  it('is refused as anything but a whole number of milliseconds up to 10 minutes', () => {
    const problem = (wait: unknown) => {
      const parsed = StepSchema.safeParse({ wait })
      return parsed.success ? null : parsed.error.issues.map((issue) => issue.message).join('; ')
    }
    expect(problem(1.5)).toBe(
      'wait: 1.5 is not a whole number of milliseconds, 0 or more; wait: 1500 waits a second and a half (SPEC.md §2.1)'
    )
    expect(problem(-1)).toContain('wait: -1 is not a whole number of milliseconds')
    expect(problem(MAX_WAIT_MS + 1)).toBe(
      'wait: 600001 is longer than a wait can be, 600000 ms (10 min) (SPEC.md §2.1)'
    )
    expect(problem('2s')).toBe(
      'wait: 2s is not a number of milliseconds; write it as wait: 2000, or a {{variable}} holding one (SPEC.md §2.1)'
    )
    expect(problem(true)).toBe(
      'wait is a whole number of milliseconds, as wait: 2000, or a {{variable}} holding one (SPEC.md §2.1)'
    )
  })

  it('only waits: it has nothing of a request, and no scripts', () => {
    const problems = (step: Record<string, unknown>) => {
      const parsed = StepSchema.safeParse(step)
      return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
    }
    expect(problems({ wait: 100, GET: '/orders' })).toEqual([
      'a wait step only waits, so it cannot have GET; it holds wait, name, docs, flags and tags (SPEC.md §2.1)'
    ])
    for (const key of ['headers', 'body', 'settings', 'before', 'tests', 'forEach', 'use']) {
      const value =
        key === 'tests' || key === 'forEach' || key === 'use'
          ? 'x'
          : key === 'before'
            ? { script: 'x' }
            : key === 'body'
              ? { text: 'x' }
              : {}
      expect(problems({ wait: 100, [key]: value })).toEqual([
        `a wait step only waits, so it cannot have ${key}; it holds wait, name, docs, flags and tags (SPEC.md §2.1)`
      ])
    }
    expect(endpointProblem(CollectionSchema.parse({ steps: [{ wait: 100 }] }))).toBe(
      'an endpoint is a method and a path, not a wait: step'
    )
  })

  it('is named by how long it waits, and labelled WAIT', () => {
    expect(stepLabel(StepSchema.parse({ wait: 2000 }))).toBe('wait 2 s')
    expect(stepLabel(StepSchema.parse({ wait: '{{pause}}' }))).toBe('wait {{pause}}')
    expect(stepLabel(StepSchema.parse({ wait: 250, name: 'settle' }))).toBe('settle')
    expect(stepMethod(StepSchema.parse({ wait: 250 }))).toBe('WAIT')
    expect([0, 500, 1000, 1500, 1250, 60_000, 90_000, 61_500, 600_000].map(waitText)).toEqual([
      '0 ms',
      '500 ms',
      '1 s',
      '1.5 s',
      '1.25 s',
      '1 min',
      '1 min 30 s',
      '1 min 1.5 s',
      '10 min'
    ])
  })

  it('waits between the steps around it, sending nothing, and counts as a step that passed', async () => {
    const started = performance.now()
    const { summary, names } = await suite({
      steps: [{ POST: `${origin}/orders` }, { wait: 60 }, { GET: `${origin}/search` }]
    })
    expect(performance.now() - started).toBeGreaterThanOrEqual(60)
    expect(seen).toEqual(['POST /orders', 'GET /search'])
    expect(names).toEqual([`POST ${origin}/orders`, 'wait 60 ms', `GET ${origin}/search`])
    expect(summary).toMatchObject({ total: 3, passed: 3, failed: 0, errored: 0 })
    const wait = summary.results[1]!
    expect(wait).toMatchObject({
      request: { method: 'WAIT', url: '60 ms', headers: [], body: null },
      response: null,
      assertions: [],
      error: null,
      status: 'pass'
    })
    expect(wait.durationMs).toBeGreaterThanOrEqual(60)
  })

  it('runs no script of its collection: there is no request or response for one', async () => {
    const { summary } = await suite({
      before: { script: "throw new Error('before ran')" },
      tests: "throw new Error('tests ran')",
      steps: [{ wait: 1 }]
    })
    expect(summary.results[0]).toMatchObject({ status: 'pass', error: null })
  })

  it('waits as long as its {{variable}} says, resolved when it runs', async () => {
    const { summary } = await suite({
      vars: { pause: 20 },
      steps: [{ wait: '{{pause}}' }]
    })
    expect(summary.results[0]).toMatchObject({
      request: { method: 'WAIT', url: '20 ms' },
      status: 'pass'
    })
  })

  it('fails when its {{variable}} is no wait, or is missing', async () => {
    const { summary } = await suite({
      vars: { pause: 'soon', long: 600_001 },
      steps: [{ wait: '{{pause}}' }, { wait: '{{long}}' }, { wait: '{{nowhere}}' }]
    })
    expect(summary.results.map((result) => [result.status, result.error?.phase])).toEqual([
      ['error', 'wait'],
      ['error', 'wait'],
      ['error', 'interpolate']
    ])
    expect(summary.results[0]!.error!.message).toBe(
      'wait: {{pause}} is "soon", not a whole number of milliseconds from 0 to 600000 (SPEC.md §2.1)'
    )
    expect(summary.results[0]!.request.url).toBe('{{pause}}')
  })

  it('is cut short by a cancel, and teardown still runs after it', async () => {
    const cancel = new AbortController()
    let started = performance.now()
    const { summary } = await suite(
      {
        steps: [{ GET: `${origin}/first` }, { wait: 5000 }, { GET: `${origin}/never` }],
        teardown: [{ DELETE: `${origin}/orders` }]
      },
      {
        signal: cancel.signal,
        // Cancelled once the wait is under way. A timer set as the test starts can
        // fire before the run reaches its first step on a slow machine, and a run
        // stopped before anything ran leaves teardown nothing to clean up after.
        onResult: (result) => {
          if (!result.request.url.endsWith('/first')) return
          started = performance.now()
          setTimeout(() => cancel.abort(), 30)
        }
      }
    )
    expect(performance.now() - started).toBeLessThan(2000)
    expect(seen).toEqual(['GET /first', 'DELETE /orders'])
    expect(summary.results[1]).toMatchObject({
      status: 'error',
      error: { phase: 'wait', code: 'ABORTED' }
    })
    expect(summary.results[1]!.error!.message).toMatch(/^Wait cancelled after \d+ ms of 5 s$/)
  })

  it('runs in setup and teardown, and is skipped as any step is', async () => {
    const { names, summary } = await suite({
      setup: [{ wait: 1, name: 'settle' }],
      steps: [
        { GET: `${origin}/one`, tests: "gta.skipRest('done')" },
        { wait: 1 },
        { wait: 1, flags: { never: true } }
      ],
      teardown: [{ wait: 1 }]
    })
    expect(names).toEqual([
      'setup › settle',
      `GET ${origin}/one`,
      'wait 1 ms',
      'wait 1 ms',
      'teardown › wait 1 ms'
    ])
    expect(summary.results.map((result) => result.status)).toEqual([
      'pass',
      'pass',
      'skipped',
      'skipped',
      'pass'
    ])
  })

  it('in reusable requests, waits there; the use step’s tests check the last request', async () => {
    const { summary, names } = await suite({
      steps: [
        {
          use: 'create-then-settle',
          name: 'create',
          with: { settle: 15 },
          tests: "gta.expectResponseBodyToHaveProperty('url', '/orders')"
        }
      ]
    })
    expect(names).toEqual(['create › create', 'create › wait {{params.settle}}'])
    expect(summary.results.map((result) => [result.status, result.assertions.length])).toEqual([
      ['pass', 1],
      ['pass', 0]
    ])
    expect(summary.results[1]).toMatchObject({
      request: { url: '15 ms' },
      use: { set: 'create-then-settle', name: 'create', child: 1, of: 2 }
    })
  })

  it('cannot be all a use step with tests runs: there is no response to check', async () => {
    const { summary } = await suite({
      steps: [{ use: 'pause', tests: 'gta.expectResponseStatusCodeToBe(200)' }, { use: 'pause' }]
    })
    expect(summary.results.map((result) => result.status)).toEqual(['error', 'pass'])
    expect(summary.results[0]!.error!.message).toBe(
      "use: pause — every step of it waits, so the use step's tests have no response to check"
    )
  })

  it('runs on its own, as a single step is sent in the app', async () => {
    const result = await runRequest({ step: StepSchema.parse({ wait: 5 }) })
    expect(result).toMatchObject({
      item: { name: 'wait 5 ms' },
      request: { method: 'WAIT', url: '5 ms' },
      status: 'pass'
    })
  })

  it('sent on its own, resolves its {{variable}} from the collection, or has none to resolve', async () => {
    const collection = CollectionSchema.parse({
      id: 'orders',
      vars: { pause: 15 },
      steps: [{ wait: '{{pause}}' }]
    })
    const step = collection.steps[0]!
    const context = { collectionPath, env: {}, dataRow: null, collectionVars: collection.vars! }
    expect(await runRequest({ step, collection, itemPath: collectionPath, context })).toMatchObject(
      { request: { url: '15 ms' }, status: 'pass' }
    )
    // With no collection to read, there is no value for it.
    expect(await runRequest({ step })).toMatchObject({
      status: 'error',
      error: { phase: 'interpolate' }
    })
  })

  it('in reusable requests run on their own, waits as long as a param’s default says', async () => {
    const set = {
      id: 'settle',
      params: { ms: 12 },
      steps: [{ wait: '{{params.ms}}' }]
    }
    // Opened and run, as the app's Run all runs it: on its params' defaults.
    const { summary } = await suite(set)
    expect(summary.results[0]).toMatchObject({ request: { url: '12 ms' }, status: 'pass' })
    // Sent on its own: its params read from the file there and then.
    const collection = CollectionSchema.parse({ ...set, params: { ms: 7 } })
    expect(await runRequest({ step: collection.steps[0]!, collection })).toMatchObject({
      request: { url: '7 ms' },
      status: 'pass'
    })
  })

  it('first in reusable requests whose values cannot be resolved, fails as the use does', async () => {
    const { summary } = await suite({
      steps: [{ use: 'settle-then-read', with: { ms: '{{nowhere}}' } }]
    })
    expect(seen).toEqual([])
    expect(summary.results.map((result) => [result.status, result.error?.phase])).toEqual([
      ['error', 'use'],
      ['error', 'use']
    ])
    expect(summary.results[0]!.error!.message).toMatch(/^use: settle-then-read — /)
  })
})
