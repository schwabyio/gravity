import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core'
import { htmlReport, type HtmlCollection, type HtmlRun } from './html.js'
import type { CollectionTally } from './report.js'

const result = (name: string, over: Partial<RunResult> = {}): RunResult => ({
  item: { path: 'collections/a.yml', name, seq: null },
  request: {
    method: 'GET',
    url: 'http://x/items',
    headers: [{ name: 'Accept', value: '*/*' }],
    body: null
  },
  response: {
    status: 200,
    statusText: 'OK',
    url: 'http://x/items',
    headers: [{ name: 'content-type', value: 'application/json' }],
    body: '{"id":1}',
    bodyKind: 'json',
    sizeBytes: 8,
    redirectCount: 0,
    timings: { startedAt: 0, ttfbMs: 5, totalMs: 7 }
  },
  assertions: [{ name: 'Status is 200', status: 'pass' }],
  error: null,
  status: 'pass',
  durationMs: 9,
  ...over
})

const tallyOf = (passed: boolean): CollectionTally => ({
  id: 'x',
  passed,
  durationMs: 10,
  steps: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, errored: 0, skipped: 0 },
  assertions: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1 },
  skipped: false,
  error: null,
  problems: []
})

const collection = (id: string, results: RunResult[], passed = true): HtmlCollection => ({
  id,
  file: `collections/${id}.yml`,
  startedAt: 0,
  durationMs: 10,
  tally: { ...tallyOf(passed), id },
  outcome: {
    ok: true,
    summary: {
      total: results.length,
      passed: 0,
      failed: 0,
      errored: 0,
      skipped: 0,
      durationMs: 10,
      results
    },
    steps: results.map((_, index) => ({ index, line: index + 3 })),
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
  tags: [],
  bail: false,
  excluded: ['legacy'],
  untagged: 0,
  startedAt: 0,
  durationMs: 1234,
  collections
})

const pages = (r: HtmlRun) => new Map(htmlReport(r).map((p) => [p.path, p.html]))

describe('htmlReport', () => {
  it('is a summary page and a page per collection, loading nothing from the network', () => {
    const report = pages(
      run(collection('smoke', [result('list')]), collection('sessions', [result('create')]))
    )
    expect([...report.keys()]).toEqual(['summary.html', 'smoke.html', 'sessions.html'])
    for (const html of report.values()) {
      expect(html).toMatch(/^<!doctype html>/)
      expect(html).not.toMatch(/<(link|script)[^>]+(href|src)=/)
      expect(html).toContain('gta Version 1.2.3')
      expect(html).toContain('Run in /work/shop')
      // Light or dark, with the system.
      expect(html).toContain('@media (prefers-color-scheme:dark)')
    }
  })

  it('lays the summary out as xrun did: Settings, Summary Stats, Results Overview', () => {
    const summary = pages(run(collection('smoke', [result('list')]))).get('summary.html')!
    expect(summary).toContain('<title>PASSED · Shop · gta Summary Results</title>')
    expect(summary).toContain('<h2 class="page-title">gta Summary Results</h2>')
    expect(summary).toContain('<div class="card-header">Settings</div>')
    expect(summary).toContain(
      '<div class="field"><div class="label">Environment</div><div class="value fit">staging</div></div>'
    )
    expect(summary).toContain(
      '<div class="label">Excluded</div><div class="value fit">legacy</div>'
    )
    expect(summary).toContain('<div class="card-header">Summary Stats</div>')
    expect(summary).toContain('<td>Final Result</td>')
    expect(summary).toContain('<span class="c-passed">PASSED</span>')
    expect(summary).toContain('<div class="card-header">Results Overview</div>')
    expect(summary).toContain('<th>Collection ID</th>')
    expect(summary).toContain('<a href="smoke.html">smoke</a>')
    expect(summary).toContain('Hide Passed')
    // A search box narrows the rows, matched on each one's id.
    expect(summary).toContain(
      'placeholder="Search collections" aria-label="Search collections" data-target="tr[data-search]"'
    )
    expect(summary).toContain('<tr class="passed" data-search="smoke">')
    // Nothing failed, so there is nothing for Hide Failed to hide.
    expect(summary).not.toContain('Hide Failed')
  })

  it('gives each collection page its description, stats and a way back', () => {
    const page = pages(
      run({
        ...collection('smoke', [result('list')]),
        docs: 'Objective: **smoke** the <API>.\n\n- one [link](https://x.test)\n- `two` [bad](javascript:alert(1))'
      })
    ).get('smoke.html')!
    expect(page).toContain('<h2 class="page-title">gta Collection Results</h2>')
    expect(page).toContain(
      '<div class="label">Collection ID</div><div class="value wide">smoke</div>'
    )
    expect(page).toContain('<div class="label">Collection Docs</div>')
    // Markdown, as the app renders it, with everything escaped and only http(s) links.
    expect(page).toContain('<p class="md-p">Objective: <strong>smoke</strong> the &lt;API&gt;.</p>')
    expect(page).toContain(
      '<li>one <a href="https://x.test" target="_blank" rel="noreferrer noopener">link</a></li>'
    )
    expect(page).toContain(
      '<li><code class="md-inline-code">two</code> bad (javascript:alert(1))</li>'
    )
    expect(page).not.toContain('href="javascript')
    expect(page).toContain('<td>Overall Result</td>')
    expect(page).toContain('<a class="btn" href="summary.html">Summary</a>')
  })

  it('opens failed tests, with each failed assertion’s expected and actual', () => {
    const page = pages(
      run(
        collection(
          'bad',
          [
            result('fine'),
            result('broken', {
              status: 'fail',
              assertions: [
                {
                  name: 'Status is 201',
                  status: 'fail',
                  message: 'Expected 201, got 200',
                  expected: 'is 201',
                  actual: '200'
                }
              ]
            })
          ],
          false
        )
      )
    ).get('bad.html')!
    expect(page).toContain('<title>FAILED · bad · gta Collection Results</title>')
    expect(page).toMatch(
      /<details class="acc passed passed" data-search="fine">\n<summary><span>Test 1: fine<\/span>/
    )
    expect(page).toMatch(
      /<details class="acc failed failed" data-search="broken" open>\n<summary><span>Test 2: broken<\/span>/
    )
    expect(page).toContain('<div class="card-header">Request</div>')
    expect(page).toContain('<div class="card-header">Response</div>')
    expect(page).toContain('<div class="card-header">Assertions</div>')
    expect(page).toContain(
      '<div class="detail-row"><div>Status is 201<div class="c-failed">Expected 201, got 200</div><div class="ea"><span class="dim">expected</span> <code>is 201</code></div><div class="ea"><span class="dim">actual</span> <code>200</code></div></div><span class="c-failed">FAILED</span></div>'
    )
    expect(page).toContain('Hide Passed')
    expect(page).toContain('Hide Failed')
    expect(page).toContain(
      'placeholder="Search steps" aria-label="Search steps" data-target="details[data-search]"'
    )
    // A passed test starts closed, so the button offers to expand.
    expect(page).toContain('onclick="expandAll()">Expand All</button>')
  })

  it('names a request a named use step ran by the use step, and searches by that name', () => {
    const page = pages(
      run(
        collection('users', [
          result('get profile', { use: { set: 'create-user', name: 'User 1', child: 1, of: 3 } })
        ])
      )
    ).get('users.html')!
    expect(page).toContain(
      '<details class="acc passed passed" data-search="user 1 › get profile">\n<summary><span>Test 1: User 1 › get profile <span class="dim">(create-user 2/3)</span></span>'
    )
  })

  it('shows a test’s error in its own card, errored tests counting as failed for Hide Failed', () => {
    const page = pages(
      run(
        collection(
          'a',
          [
            result('login', {
              status: 'error',
              error: { phase: 'tests', message: 'SyntaxError: nope', script: 'step', line: 7 }
            })
          ],
          false
        )
      )
    ).get('a.html')!
    expect(page).toContain('<details class="acc failed errored" data-search="login" open>')
    // Every test starts open, so the button offers to collapse.
    expect(page).toContain('onclick="expandAll()">Collapse All</button>')
    expect(page).toContain('<div class="card-header">Error</div>')
    expect(page).toContain('(step script, line 7) SyntaxError: nope')
  })

  it('pretty-prints a JSON body and escapes everything it shows', () => {
    const page = pages(
      run(
        collection('a', [
          result('<script>alert(1)</script>', {
            request: { method: 'POST', url: 'http://x/?a=1&b=2', headers: [], body: '<b>' }
          })
        ])
      )
    ).get('a.html')!
    expect(page).toContain('{\n  &quot;id&quot;: 1\n}')
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('http://x/?a=1&amp;b=2')
  })

  it('says why a collection did not run', () => {
    const page = pages(
      run({
        id: 'slow',
        file: 'collections/slow.yml',
        startedAt: 0,
        durationMs: 500,
        tally: { ...tallyOf(false), id: 'slow' },
        outcome: { ok: false, message: 'Timed out after 500 ms (timeoutCollection)' }
      })
    ).get('slow.html')!
    expect(page).toContain('<div class="label">Error</div>')
    expect(page).toContain('Timed out after 500 ms (timeoutCollection)')
  })

  it('cuts a very large body, saying how much is missing', () => {
    const big = 'x'.repeat(300 * 1024)
    const page = pages(
      run(
        collection('a', [
          result('big', { response: { ...result('r').response!, bodyKind: 'text', body: big } })
        ])
      )
    ).get('a.html')!
    expect(page).toContain('44.0 KB more not shown')
    expect(page.length).toBeLessThan(big.length)
  })
})
