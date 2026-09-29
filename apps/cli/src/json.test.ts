import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core'
import type { HtmlCollection, HtmlRun } from './html.js'
import { jsonError, jsonReport } from './json.js'

/** The report as a reader gets it: through JSON, so it is plain data. */
const read = (...args: Parameters<typeof jsonReport>) =>
  JSON.parse(JSON.stringify(jsonReport(...args)))

const result = (over: Partial<RunResult> = {}): RunResult => ({
  item: { path: 'collections/a.yml', name: 'step', seq: null },
  request: { method: 'POST', url: 'http://x/', headers: [], body: 'ping' },
  response: {
    status: 200,
    statusText: 'OK',
    url: 'http://x/',
    headers: [],
    body: 'pong',
    bodyKind: 'text',
    sizeBytes: 4,
    redirectCount: 0,
    timings: { startedAt: 0, ttfbMs: 1, totalMs: 2 }
  },
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 3,
  ...over
})

const collection = (results: RunResult[], skipped = 0): HtmlCollection => ({
  id: 'a',
  file: 'collections/a.yml',
  startedAt: Date.UTC(2026, 8, 27),
  durationMs: 12.6,
  tally: {
    id: 'a',
    passed: true,
    durationMs: 12.6,
    steps: {
      total: results.length + skipped,
      passed: results.length,
      failed: 0,
      errored: 0,
      skipped
    },
    assertions: { total: 0, passed: 0, failed: 0 },
    skipped: false,
    error: null,
    problems: []
  },
  outcome: {
    ok: true,
    summary: {
      total: results.length + skipped,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped,
      durationMs: 12,
      results
    },
    steps: results.map((_, index) => ({ index: index + 1, line: 10 * (index + 1) })),
    data: null
  }
})

const run = (...collections: HtmlCollection[]): HtmlRun => ({
  project: 'Shop',
  root: '/work/shop',
  version: '1.2.3',
  environment: 'staging',
  concurrency: 4,
  timeoutCollection: 60000,
  tags: ['smoke'],
  bail: false,
  excluded: ['legacy'],
  untagged: 1,
  startedAt: Date.UTC(2026, 8, 27),
  durationMs: 1234.4,
  collections
})

describe('jsonReport', () => {
  it('holds the run, its settings and totals, and each step’s result with where it is', () => {
    const report = read(run(collection([result()], 2)), { json: '/r/json/results.json' })
    expect(report).toMatchObject({
      formatVersion: 1,
      tool: { name: 'gta', version: '1.2.3' },
      project: { name: 'Shop', root: '/work/shop' },
      run: {
        result: 'passed',
        startedAt: '2026-09-27T00:00:00.000Z',
        durationMs: 1234,
        environment: 'staging',
        settings: { limitConcurrency: 4, timeoutCollection: 60000, bail: false, tags: ['smoke'] }
      },
      leftOut: { excluded: ['legacy'], untagged: 1 },
      reports: { json: '/r/json/results.json' }
    })
    const [a] = report.collections
    expect(a).toMatchObject({
      id: 'a',
      file: 'collections/a.yml',
      status: 'passed',
      error: null,
      notRun: 2
    })
    expect(a.steps[0]).toMatchObject({
      step: { index: 1, line: 10 },
      status: 'pass',
      request: { method: 'POST', body: 'ping' },
      response: { status: 200, body: 'pong' }
    })
    expect(a.steps[0]).not.toHaveProperty('truncated')
    // Plain JSON all the way down: nothing lost on the way through.
    expect(read(run(collection([result()], 2)), { json: '/r/json/results.json' })).toEqual(
      jsonReport(run(collection([result()], 2)), { json: '/r/json/results.json' })
    )
  })

  it('cuts a very large body and says so, with its full length', () => {
    const big = 'x'.repeat(300 * 1024)
    const report = read(
      run(collection([result({ response: { ...result().response!, body: big } })])),
      {}
    )
    const step = report.collections[0].steps[0]
    expect(step.response.body).toHaveLength(256 * 1024)
    expect(step.truncated).toEqual({ 'response.body': big.length })
  })

  it('says why a collection did not run', () => {
    const report = read(
      run({
        ...collection([]),
        outcome: { ok: false, message: 'Timed out after 500 ms (timeoutCollection)' }
      }),
      {}
    )
    expect(report.collections[0]).toMatchObject({
      error: 'Timed out after 500 ms (timeoutCollection)',
      steps: []
    })
  })

  it('has one shape for an error', () => {
    expect(jsonError('bad settings', 2)).toEqual({
      formatVersion: 1,
      error: { message: 'bad settings', exitCode: 2 }
    })
  })
})
