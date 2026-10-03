import { describe, expect, it } from 'vitest'
import type { AssertionResult, RunResult } from '@schwabyio/gravity-core'
import { junitReport, type JUnitCollection } from './junit.js'

const result = (name: string, over: Partial<RunResult> = {}): RunResult => ({
  item: { path: 'collections/a.yml', name, seq: null },
  request: { method: 'GET', url: 'http://x/', headers: [], body: null },
  response: null,
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 12,
  ...over
})

const failed: AssertionResult = {
  name: 'Status code',
  status: 'fail',
  message: 'Expected 200',
  expected: '200',
  actual: '500'
}

const ran = (id: string, results: RunResult[], skipped = 0): JUnitCollection => ({
  id,
  startedAt: Date.UTC(2026, 8, 26, 8, 0, 0),
  durationMs: 1500,
  outcome: {
    ok: true,
    summary: {
      total: results.length + skipped,
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      errored: results.filter((r) => r.status === 'error').length,
      skipped,
      durationMs: 1500,
      results
    },
    steps: results.map((_, index) => ({ index, line: null })),
    data: null
  }
})

const report = (...collections: JUnitCollection[]) =>
  junitReport({
    project: 'Shop',
    environment: 'staging',
    startedAt: Date.UTC(2026, 8, 26, 8, 0, 0),
    durationMs: 2500,
    collections
  })

describe('junitReport', () => {
  it('writes a suite per collection and a case per step, with totals', () => {
    const xml = report(
      ran('checkout/sessions', [
        result('create'),
        result('read', { status: 'fail', assertions: [failed] })
      ]),
      ran('smoke', [result('ping')])
    )
    expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<testsuites /)
    expect(xml).toContain(
      '<testsuites name="gta: Shop" tests="3" failures="1" errors="0" skipped="0" time="2.500" timestamp="2026-09-26T08:00:00">'
    )
    expect(xml).toMatch(
      /<testsuite name="checkout\/sessions" tests="2" failures="1" errors="0" skipped="0" time="1.500" timestamp="2026-09-26T08:00:00" hostname="[^"]+">/
    )
    expect(xml).toContain('<property name="environment" value="staging"/>')
    expect(xml).toContain('<testcase name="create" classname="checkout/sessions" time="0.012"/>')
    expect(xml).toContain(
      '<failure message="Status code: Expected 200" type="assertion">Status code: Expected 200\n  expected: 200\n  actual:   500</failure>'
    )
  })

  it('reports an error by its phase, and what the scripts logged', () => {
    const xml = report(
      ran('a', [
        result('login', {
          status: 'error',
          error: { phase: 'interpolate', message: 'Variable "token" is not defined' },
          logs: [{ level: 'log', message: 'about to log in', phase: 'pre-request' }]
        })
      ])
    )
    expect(xml).toContain('errors="1"')
    expect(xml).toContain(
      '<error message="interpolate error: Variable &quot;token&quot; is not defined" type="interpolate">Variable "token" is not defined</error>'
    )
    expect(xml).toContain('<system-out>[pre-request log] about to log in</system-out>')
  })

  it('keeps a script error’s own lines, not gta’s frames', () => {
    const stack = [
      'tests:2',
      'gta.oops(',
      '         ^',
      'SyntaxError: Unexpected end of input',
      '    at new Script (node:vm:117:7)',
      '    at runScript (file:///x/dist/chunks/chunk.js:10:2)'
    ].join('\n')
    const xml = report(
      ran('a', [
        result('bad', {
          status: 'error',
          error: { phase: 'tests', message: 'SyntaxError: Unexpected end of input', stack }
        })
      ])
    )
    expect(xml).toContain(
      'type="tests">tests:2\ngta.oops(\n         ^\nSyntaxError: Unexpected end of input</error>'
    )
  })

  it('names a request a use step ran by its place in the set', () => {
    const xml = report(ran('a', [result('get token', { use: { set: 'login', child: 1, of: 3 } })]))
    expect(xml).toContain('name="get token [login 2/3]"')
  })

  it('names a request a named use step ran by the use step, then the set’s step', () => {
    const xml = report(
      ran('a', [
        result('wait', {
          use: { set: 'wait', name: 'wait for the invite email', child: 0, of: 1 }
        }),
        result('get profile', { use: { set: 'create-user', name: 'user 1', child: 1, of: 3 } })
      ])
    )
    expect(xml).toContain('name="wait for the invite email [wait 1/1]"')
    expect(xml).toContain('name="user 1 › get profile [create-user 2/3]"')
  })

  it('names each item of a forEach step, and a setup or teardown step, as the HTML report does', () => {
    const each = (index: number) =>
      result('grant role', { forEach: { index, of: 2, item: `role-${index}` } })
    const xml = report(
      ran('roles', [
        result('sign in', { stage: 'setup' }),
        each(0),
        each(1),
        result('clean up', { stage: 'teardown' })
      ])
    )
    expect(xml).toContain('name="setup › sign in"')
    expect(xml).toContain('name="grant role (item 1 of 2)"')
    expect(xml).toContain('name="grant role (item 2 of 2)"')
    expect(xml).toContain('name="teardown › clean up"')
  })

  it('counts steps a bail left unrun as skipped', () => {
    const xml = report(ran('a', [result('one', { status: 'fail', assertions: [failed] })], 2))
    expect(xml).toContain('tests="2" failures="1" errors="0" skipped="1"')
    expect(xml).toContain(
      '<skipped message="2 steps not run: the collection stopped at its first failure (bail)"/>'
    )
  })

  it('reports a collection that never ran as one error', () => {
    const xml = report({
      id: 'slow',
      startedAt: 0,
      durationMs: 500,
      outcome: { ok: false, message: 'Timed out after 500 ms (timeoutCollection)' }
    })
    expect(xml).toContain('<testsuite name="slow" tests="1" failures="0" errors="1" skipped="0"')
    expect(xml).toContain('<testcase name="(collection)" classname="slow" time="0.000">')
    expect(xml).toContain('type="collection">Timed out after 500 ms (timeoutCollection)</error>')
  })

  it('escapes markup, keeps newlines in attributes, and drops what XML cannot hold', () => {
    const control = String.fromCharCode(1)
    const xml = report(
      ran('a', [
        result('<b> & "c"', {
          status: 'fail',
          assertions: [{ ...failed, message: `line one\nline two${control}` }]
        })
      ])
    )
    expect(xml).toContain('name="&lt;b&gt; &amp; &quot;c&quot;"')
    expect(xml).toContain('message="Status code: line one&#10;line two"')
    expect(xml).not.toContain(control)
  })
})
