import {
  parseEventStream,
  parseMarkdown,
  resultName,
  type AssertionResult,
  type EventStreamRead,
  type HeaderEntry,
  type MdBlock,
  type MdInline,
  type RunResult
} from '@schwabyio/gravity-core'
import { iterationName, unattempted, type StepRef } from './job.js'
import type { JUnitCollection, JUnitRun } from './junit.js'
import type { CollectionTally } from './report.js'

/**
 * The run as HTML, laid out as xrun's reports are: a summary page — Settings,
 * Summary Stats, Results Overview — and a page per collection it links to,
 * with a "Test N" section per step holding Request, Response and Assertions
 * cards. Light or dark with the system.
 *
 * The pages load nothing from the network — no CDN, no fonts — so they open the
 * same from a CI artifact or a machine with no connection. The folder they go
 * in is deleted before each run, so a collection that did not run this time
 * never leaves a page behind.
 *
 * Failed and errored tests open expanded; passed ones are a click away.
 * Secrets are already `[secret: NAME]` in the results this is given.
 */
export interface HtmlCollection extends JUnitCollection {
  /** The collection file, from the project folder, written with `/`. */
  file: string
  tally: CollectionTally
  /** The collection's `docs:`, Markdown, shown as Collection Docs. */
  docs?: string | undefined
}

export interface HtmlRun extends JUnitRun {
  version: string
  root: string
  concurrency: number
  timeoutCollection: number
  tags: readonly string[]
  /** Tags left out (`notTags`). */
  notTags?: readonly string[]
  bail: boolean
  /** Collections left out with `exclude: true`, by id. */
  excluded: readonly string[]
  /** How many collections a tag selection left with nothing to run. */
  untagged: number
  /** Where each feature flag value came from, and the command run for them (SPEC.md §2.9). */
  flagSources?: Record<string, 'environment' | 'command' | 'override'>
  flagCommand?: string | null
  collections: readonly HtmlCollection[]
}

/** A response body longer than this is cut in the report; the run saw all of it. */
const BODY_LIMIT = 256 * 1024

/** The summary page's name in the report's folder. */
export const SUMMARY_PAGE = 'summary.html'

/** One page of the report, by its path inside the report's folder, written with `/`. */
export interface HtmlPage {
  path: string
  html: string
}

/**
 * The summary page, and a page per collection beside it, named by its id:
 * `sessions.html`. Ids are unique in a project, so the pages sit side by side
 * whatever directories the collections are in.
 */
export function htmlReport(run: HtmlRun): HtmlPage[] {
  return [
    { path: SUMMARY_PAGE, html: summaryPage(run) },
    ...run.collections.map((c) => ({ path: pageOf(c.id), html: collectionPage(run, c) }))
  ]
}

const pageOf = (id: string) => `${id}.html`

/** `newCheckout=true, pricing=v2`, or none. */
export const flagList = (flags: Record<string, string | number | boolean>): string => {
  const entries = Object.entries(flags)
  return entries.length > 0 ? entries.map(([name, value]) => `${name}=${value}`).join(', ') : 'none'
}

type Status = 'passed' | 'failed' | 'errored' | 'skipped'

/* --------------------------------------------------------------- summary -- */

function summaryPage(run: HtmlRun): string {
  const tallies = run.collections.map((c) => c.tally)
  const sum = (pick: (t: CollectionTally) => number) => tallies.reduce((n, t) => n + pick(t), 0)
  const failedCollections = tallies.filter((t) => !t.passed).length
  const passed = failedCollections === 0

  const settings: Array<[string, string]> = [
    ['Project Name', run.project],
    ['Collection Timeout', `${run.timeoutCollection} ms`],
    ['Environment', run.environment ?? 'none'],
    ['Concurrency Limit', String(run.concurrency)],
    ['Tags', run.tags.length > 0 ? run.tags.join(', ') : 'none'],
    ...(run.notTags?.length
      ? ([['Not Tags', run.notTags.join(', ')]] as Array<[string, string]>)
      : []),
    ['Excluded', run.excluded.length > 0 ? run.excluded.join(', ') : 'none'],
    ['Feature Flags', flagList(run.flags ?? {})],
    ...(run.flagCommand ? ([['Flag Command', run.flagCommand]] as Array<[string, string]>) : []),
    ...(run.bail ? ([['Bail', 'on']] as Array<[string, string]>) : []),
    ...(run.untagged > 0
      ? ([
          ['Left Out By Tags', `${run.untagged} collection${run.untagged === 1 ? '' : 's'}`]
        ] as Array<[string, string]>)
      : [])
  ]

  const overview = run.collections
    .map((c, i) => {
      const t = c.tally
      const status: Status = t.skipped ? 'skipped' : t.passed ? 'passed' : 'failed'
      const cells = [
        seconds(c.durationMs),
        t.steps.total,
        t.steps.passed,
        t.steps.failed,
        t.steps.errored,
        t.steps.skipped,
        t.assertions.total,
        t.assertions.passed,
        t.assertions.failed
      ]
      return `<tr class="${status}" data-search="${escape(c.id.toLowerCase())}"><td>${i + 1}</td><td class="name"><a href="${escape(encodeURI(pageOf(c.id)))}">${escape(c.id)}</a></td>${cells
        .map((v) => `<td>${v}</td>`)
        .join('')}<td>${statusText(status)}</td></tr>`
    })
    .join('\n')

  return page({
    title: `${passed ? 'PASSED' : 'FAILED'} · ${run.project} · gta Summary Results`,
    run,
    body: `<h2 class="page-title">gta Summary Results</h2>

<div class="card"><div class="card-header">Settings</div><div class="card-body"><div class="pairs">
${settings.map(([label, value]) => field(label, escape(value))).join('\n')}
</div></div></div>

<div class="card"><div class="card-header">Summary Stats</div><div class="card-body">
${field('Time of Run', escape(timeOfRun(run.startedAt)))}
${statsTable([
  ['Total Collections', tallies.length],
  ['Collections Passed', tallies.length - failedCollections],
  ['Collections Failed', failedCollections],
  ['Total Tests', sum((t) => t.steps.total)],
  ['Tests Passed', sum((t) => t.steps.passed)],
  ['Tests Failed', sum((t) => t.steps.failed)],
  ['Tests Errored', sum((t) => t.steps.errored)],
  ['Tests Skipped', sum((t) => t.steps.skipped)],
  ['Total Assertions', sum((t) => t.assertions.total)],
  ['Assertions Passed', sum((t) => t.assertions.passed)],
  ['Assertions Failed', sum((t) => t.assertions.failed)],
  ['Total Run Time', seconds(run.durationMs)],
  ['Final Result', finalResult(passed)]
])}
</div></div>

<div class="toolbar above">${searchBox('Search collections', 'tr[data-search]')}<div class="buttons">${hideButtons(
      tallies.some((t) => t.passed && !t.skipped),
      failedCollections > 0,
      tallies.some((t) => t.skipped)
    )}</div></div>
<div class="card"><div class="card-header">Results Overview</div><div class="card-body">
<table class="overview">
<tr><th>Collection #</th><th>Collection ID</th><th>Collection Run Time</th><th>Total Tests</th><th>Tests Passed</th><th>Tests Failed</th><th>Tests Errored</th><th>Tests Skipped</th><th>Total Assertions</th><th>Assertions Passed</th><th>Assertions Failed</th><th>Collection Result</th></tr>
${overview}
</table>
</div></div>`
  })
}

/* ------------------------------------------------------------ collection -- */

function collectionPage(run: HtmlRun, c: HtmlCollection): string {
  const t = c.tally
  const tests = !c.outcome.ok
    ? ''
    : [
        ...c.outcome.summary.results.map((r, i) =>
          testSection(r, i, c.outcome.ok ? c.outcome.steps[i] : undefined)
        ),
        unattempted(c.outcome.summary) > 0 ? notRunSection(unattempted(c.outcome.summary)) : ''
      ].join('\n')
  const statuses = c.outcome.ok ? c.outcome.summary.results.map(statusOf) : []

  return page({
    title: `${t.skipped ? 'SKIPPED' : t.passed ? 'PASSED' : 'FAILED'} · ${c.id} · gta Collection Results`,
    run,
    body: `<h2 class="page-title">gta Collection Results</h2>

<div class="card"><div class="card-header">Results Overview</div><div class="card-body">
${field('Collection ID', escape(c.id), 'wide')}
${c.docs?.trim() ? field('Collection Docs', markdown(c.docs), 'wide') : ''}
${c.outcome.ok && c.outcome.data ? field('Data File', escape(c.outcome.data.file), 'wide') : ''}
${c.outcome.ok && c.outcome.data ? field('Iterations', String(c.outcome.data.rows)) : ''}
${!c.outcome.ok ? field('Error', `<pre class="c-failed">${escape(c.outcome.message)}</pre>`, 'wide') : ''}
${field('Time of Run', escape(timeOfRun(c.startedAt)))}
${statsTable([
  ['Collection Run Time', seconds(c.durationMs)],
  ['Total Tests', t.steps.total],
  ['Tests Passed', t.steps.passed],
  ['Tests Failed', t.steps.failed],
  ['Tests Errored', t.steps.errored],
  ['Tests Skipped', t.steps.skipped],
  ['Total Assertions', t.assertions.total],
  ['Assertions Passed', t.assertions.passed],
  ['Assertions Failed', t.assertions.failed],
  ['Overall Result', t.skipped ? '<span class="c-skipped">SKIPPED</span>' : finalResult(t.passed)]
])}
</div></div>

<div class="toolbar"><h3>Tests</h3>${statuses.length > 0 ? searchBox('Search steps', 'details[data-search]') : ''}<div class="buttons">
${hideButtons(
  statuses.includes('passed'),
  statuses.some((s) => s === 'failed' || s === 'errored'),
  statuses.includes('skipped')
)}
${
  statuses.length === 0
    ? ''
    : // Says what a click does: expand while any test is closed, as passed ones start.
      `<button type="button" class="btn" id="expand-all" onclick="expandAll()">${statuses.some((s) => s === 'passed' || s === 'skipped') ? 'Expand All' : 'Collapse All'}</button>`
}
<a class="btn" href="${SUMMARY_PAGE}">Summary</a>
</div></div>
<div class="tests">
${tests || '<p class="dim">No tests were run.</p>'}
</div>`
  })
}

const statusOf = (r: RunResult): Status =>
  r.status === 'pass'
    ? 'passed'
    : r.status === 'fail'
      ? 'failed'
      : r.status === 'error'
        ? 'errored'
        : 'skipped'

function testSection(r: RunResult, index: number, ref: StepRef | undefined): string {
  const status = statusOf(r)
  const named = escape(iterationName(resultName(r), ref))
  const name = r.use
    ? `${named} <span class="dim">(${escape(r.use.set)} ${r.use.child + 1}/${r.use.of})</span>`
    : named
  // A skipped step sent nothing: the reason — a feature flag, gta.skip — is all there is to show.
  if (r.skipped) {
    return `<details class="acc skipped skipped" data-search="${escape(iterationName(resultName(r), ref).toLowerCase())}">
<summary><span>Test ${index + 1}: ${name}</span>${icon('skipped')}</summary>
<div class="acc-body">
${card('Skipped', field('Reason', `<span class="c-skipped">${escape(r.skipped.reason)} — this test was not run</span>`, 'wide'))}
</div>
</details>`
  }
  const cards = [
    r.error ? errorCard(r) : '',
    requestCard(r),
    responseCard(r),
    assertionsCard(r.assertions),
    r.logs?.length ? consoleCard(r) : ''
  ].filter(Boolean)
  // Hide Failed takes errored tests too: both are what a failed run is made of.
  const group = status === 'passed' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed'
  // What the step search matches: the name as shown, iteration and all.
  const search = iterationName(resultName(r), ref).toLowerCase()
  return `<details class="acc ${group} ${status}" data-search="${escape(search)}"${status === 'passed' ? '' : ' open'}>
<summary><span>Test ${index + 1}: ${name}</span>${icon(status)}</summary>
<div class="acc-body">
${cards.join('\n')}
</div>
</details>`
}

function notRunSection(count: number): string {
  return `<details class="acc skipped">
<summary><span>${count} test${count === 1 ? '' : 's'} not run</span>${icon('skipped')}</summary>
<div class="acc-body"><p class="c-skipped">The collection stopped at its first failure (bail), so ${count === 1 ? 'this test was' : 'these tests were'} not run.</p></div>
</details>`
}

function errorCard(r: RunResult): string {
  const e = r.error!
  const where = [e.script && `${e.script} script`, e.line && `line ${e.line}`]
    .filter(Boolean)
    .join(', ')
  const detail = e.stack ? `\n\n${userFrames(e.stack)}` : ''
  return card(
    'Error',
    field(
      `${capitalise(e.phase)} Error`,
      `<pre class="c-failed">${escape(`${where ? `(${where}) ` : ''}${e.message}${detail}`)}</pre>`,
      'wide'
    )
  )
}

function requestCard(r: RunResult): string {
  const { request } = r
  return card(
    'Request',
    [
      field('Request Method', escape(request.method)),
      field('Request URL', escape(request.url || '—'), 'wide'),
      request.headers.length > 0
        ? field('Request Headers', scrollPre(headerText(request.headers)), 'wide')
        : '',
      request.body ? field('Request Body', scrollPre(clip(request.body)), 'wide') : ''
    ]
      .filter(Boolean)
      .join('\n')
  )
}

/** What stopped an event stream's reading (SPEC.md §2.3). */
const ENDED_BY: Record<EventStreamRead['endedBy'], string> = {
  close: 'closed by the server',
  maxEvents: 'stopped at maxEvents',
  streamTimeout: 'stopped at streamTimeout',
  untilEvent: 'stopped at untilEvent',
  limit: 'stopped at the safety limit',
  stopped: 'stopped by hand',
  held: 'took the events held'
}

/** A connection a step opened or read (SPEC.md §2.11), and whether it was left open. */
const connectionNote = (stream: EventStreamRead): string =>
  stream.connection
    ? `, connection ${stream.connection.name} ${stream.connection.open ? 'open' : 'closed'}`
    : ''

function responseCard(r: RunResult): string {
  const res = r.response
  if (!res) {
    return card(
      'Response',
      field('Failure', '<span class="c-failed">No response was received.</span>', 'wide')
    )
  }
  // An event stream is shown as the events its checks' paths address.
  const events = res.bodyKind === 'events'
  const body =
    res.bodyKind === 'json'
      ? prettyJson(res.body)
      : events
        ? JSON.stringify(parseEventStream(res.body), null, 2)
        : res.body
  const extra = [
    `first byte ${Math.round(res.timings.ttfbMs)}ms`,
    bytes(res.sizeBytes),
    res.redirectCount > 0
      ? `${res.redirectCount} redirect${res.redirectCount === 1 ? '' : 's'}`
      : '',
    res.stream
      ? `${res.stream.at.length} event${res.stream.at.length === 1 ? '' : 's'}, ${ENDED_BY[res.stream.endedBy]}${connectionNote(res.stream)}`
      : ''
  ].filter(Boolean)
  return card(
    'Response',
    [
      field('Response Code', escape(`${res.status} ${res.statusText}`.trim())),
      res.headers.length > 0
        ? field('Response Headers', scrollPre(headerText(res.headers)), 'wide')
        : '',
      body
        ? field(events ? 'Response Events' : 'Response Body', scrollPre(clip(body)), 'wide')
        : '',
      field(
        'Response Time',
        `${Math.round(res.timings.totalMs)}ms <span class="dim">· ${extra.join(' · ')}</span>`
      )
    ]
      .filter(Boolean)
      .join('\n')
  )
}

function assertionsCard(assertions: AssertionResult[]): string {
  const failed = assertions.filter((a) => a.status === 'fail').length
  const counts = statsTable(
    [
      ['Total Assertions', assertions.length],
      ['Assertions Passed', assertions.length - failed],
      ['Assertions Failed', failed]
    ],
    'small'
  )
  if (assertions.length === 0) return card('Assertions', counts)
  const list = assertions
    .map((a) => {
      const failing = a.status === 'fail'
      const extra = [
        a.message ? `<div class="c-failed">${escape(a.message)}</div>` : '',
        failing && a.expected !== undefined
          ? `<div class="ea"><span class="dim">expected</span> <code>${escape(a.expected)}</code></div>`
          : '',
        failing && a.actual !== undefined
          ? `<div class="ea"><span class="dim">actual</span> <code>${escape(a.actual)}</code></div>`
          : '',
        a.unasserted?.length
          ? `<div class="ea"><span class="dim">not asserted</span> <code>${escape(a.unasserted.join(', '))}</code></div>`
          : ''
      ].join('')
      const result = failing
        ? '<span class="c-failed">FAILED</span>'
        : '<span class="c-passed">PASSED</span>'
      return `<div class="detail-row"><div>${escape(a.name)}${extra}</div>${result}</div>`
    })
    .join('\n')
  return card(
    'Assertions',
    `${counts}
<div class="card inner"><div class="card-header"><div class="detail-row head"><span>Detail</span><span>Result</span></div></div><div class="card-body">
${list}
</div></div>`
  )
}

function consoleCard(r: RunResult): string {
  const lines = r.logs!.map(
    (l) =>
      `<span class="log-${l.level}">[${escape(l.phase)} ${l.level}] ${escape(l.message)}</span>`
  )
  return card('Console', `<pre class="console">${lines.join('\n')}</pre>`)
}

/* ---------------------------------------------------------------- pieces -- */

function page(options: { title: string; run: HtmlRun; body: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(options.title)}</title>
<style>${STYLE}</style>
<script>${SCRIPT}</script>
</head>
<body>
<div class="container">
${options.body}
</div>
<footer class="container">
<span class="btn static">gta Version ${escape(options.run.version)}</span>
<div class="dim small-print">Run in ${escape(options.run.root)}</div>
</footer>
</body>
</html>
`
}

const card = (title: string, body: string) =>
  `<div class="card"><div class="card-header">${title}</div><div class="card-body">
${body}
</div></div>`

/** A label beside a bordered value, as xrun lays them out; `wide` fills the row. */
const field = (label: string, valueHtml: string, width: 'fit' | 'wide' = 'fit') =>
  `<div class="field"><div class="label">${escape(label)}</div><div class="value ${width}">${valueHtml}</div></div>`

function statsTable(cells: Array<[string, string | number]>, size: '' | 'small' = ''): string {
  return `<table class="stats${size ? ` ${size}` : ''}"><tr>${cells
    .map(([label]) => `<td>${escape(label)}</td>`)
    .join('')}</tr><tr>${cells.map(([, value]) => `<td>${value}</td>`).join('')}</tr></table>`
}

const finalResult = (passed: boolean) =>
  passed ? '<span class="c-passed">PASSED</span>' : '<span class="c-failed">FAILED</span>'

const statusText = (status: Status) => `<span class="c-${status}">${status}</span>`

const ICONS: Record<Status, string> = { passed: '✓', failed: '!', errored: '!', skipped: '–' }
const icon = (status: Status) =>
  `<span class="icon ${status}" role="img" aria-label="${status}">${ICONS[status]}</span>`

/**
 * A search box that narrows `target` — the summary's rows, a page's tests — to
 * those whose `data-search` holds what is typed. It works alongside Hide
 * Passed / Hide Failed: a row shows only when neither hides it.
 */
const searchBox = (label: string, target: string) =>
  `<input type="search" class="search" placeholder="${label}" aria-label="${label}" data-target="${escape(target)}" oninput="search(this)">`

/** Hide Passed / Hide Failed / Hide Skipped, each only when there is something for it to hide. */
const hideButtons = (anyPassed: boolean, anyFailed: boolean, anySkipped = false) =>
  [
    anyPassed
      ? `<button type="button" class="btn" onclick="toggle(this,'passed','Passed')">Hide Passed</button>`
      : '',
    anyFailed
      ? `<button type="button" class="btn" onclick="toggle(this,'failed','Failed')">Hide Failed</button>`
      : '',
    anySkipped
      ? `<button type="button" class="btn" onclick="toggle(this,'skipped','Skipped')">Hide Skipped</button>`
      : ''
  ].join('')

const headerText = (headers: HeaderEntry[]) =>
  headers.map((h) => `${h.name}: ${h.value}`).join('\n')

const scrollPre = (text: string) => `<div class="scroll"><pre>${escape(text)}</pre></div>`

function clip(text: string): string {
  return text.length > BODY_LIMIT
    ? `${text.slice(0, BODY_LIMIT)}\n… ${bytes(text.length - BODY_LIMIT)} more not shown`
    : text
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** A script error's stack without gta's own frames. */
const userFrames = (stack: string): string =>
  stack
    .split('\n')
    .filter((line) => !/^\s+at .*(\bnode:|file:\/\/)/.test(line))
    .join('\n')

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const seconds = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

/** xrun's "Time of Run": `Sat, September 27, 2026 at 6:14:14 AM Pacific Daylight Time`. */
const timeOfRun = (epochMs: number): string =>
  new Date(epochMs).toLocaleString('en-US', {
    weekday: 'short',
    month: 'long',
    day: '2-digit',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'long'
  })

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* -------------------------------------------------------------- markdown -- */

/**
 * A collection's docs as HTML: core's `parseMarkdown` — the reading the desktop
 * app renders too — with every string escaped, and links only to http(s).
 */
function markdown(source: string): string {
  return `<div class="md">${parseMarkdown(source).map(mdBlock).join('')}</div>`
}

function mdBlock(block: MdBlock): string {
  switch (block.type) {
    case 'code':
      return `<pre class="md-code">${escape(block.text)}</pre>`
    case 'heading': {
      const level = Math.min(block.level + 3, 6)
      return `<h${level} class="md-h">${mdInline(block.content)}</h${level}>`
    }
    case 'rule':
      return '<hr class="md-hr">'
    case 'table':
      return `<table class="md-table"><thead><tr>${block.header
        .map((cell) => `<th>${mdInline(cell)}</th>`)
        .join('')}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((cell) => `<td>${mdInline(cell)}</td>`).join('')}</tr>`)
        .join('')}</tbody></table>`
    case 'quote':
      return `<blockquote class="md-quote">${block.blocks.map(mdBlock).join('')}</blockquote>`
    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      return `<${tag} class="md-list">${block.items
        .map(
          (item) =>
            `<li>${mdInline(item.content)}${item.children ? mdBlock(item.children) : ''}</li>`
        )
        .join('')}</${tag}>`
    }
    case 'paragraph':
      return `<p class="md-p">${mdInline(block.content)}</p>`
  }
}

function mdInline(nodes: MdInline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'text':
          return escape(node.text)
        case 'code':
          return `<code class="md-inline-code">${escape(node.text)}</code>`
        case 'strong':
          return `<strong>${mdInline(node.children)}</strong>`
        case 'em':
          return `<em>${mdInline(node.children)}</em>`
        case 'link':
          return `<a href="${escape(node.href)}" target="_blank" rel="noreferrer noopener">${escape(node.label)}</a>`
      }
    })
    .join('')
}

/* --------------------------------------------------------- style, script -- */

/**
 * xrun's look — Bootstrap's cards, bordered value boxes and one-row stats
 * tables, its passed/failed/skipped colours — written out here so nothing is
 * fetched. Dark as xrun was, or light when the system is.
 */
const STYLE = `
:root{color-scheme:light dark;--bg:#f8f9fa;--card:#fff;--head:#eef0f3;--border:#dee2e6;--text:#212529;--dim:#6c757d;--passed:#198754;--failed:#d0104c;--errored:#b86e00;--skipped:#0f86b6;--open:#e3e8f0;--link:#0d6efd;--btn:#6c757d;--icon-text:#fff;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#212529;--card:#212529;--head:#2b3035;--border:#495057;--text:#dee2e6;--dim:#adb5bd;--passed:#87EA67;--failed:#F50F55;--errored:#F5A623;--skipped:#4FC3E8;--open:#393D47;--link:#6ea8fe;--btn:#adb5bd;--icon-text:#212529}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;padding:48px 0 32px}
.container{max-width:1320px;margin:0 auto;padding:0 12px}
.page-title{text-align:center;font-weight:500;font-size:2rem;margin:0 0 32px}
.card{border:1px solid var(--border);border-radius:6px;margin-bottom:24px;background:var(--card)}
.card-header{padding:8px 16px;background:var(--head);border-bottom:1px solid var(--border);border-radius:6px 6px 0 0}
.card-body{padding:16px}
.card.inner{margin:16px 0 0}
.acc-body .card{margin-bottom:16px}
.pairs{display:grid;grid-template-columns:1fr 1fr;gap:0 24px}
@media (max-width:800px){.pairs{grid-template-columns:1fr}}
.field{display:flex;gap:12px;margin-bottom:16px;align-items:flex-start;min-width:0}
.label{flex:0 0 190px}
.value{border:1px solid var(--border);border-radius:6px;padding:0 8px;min-width:0;overflow-wrap:anywhere}
.value.wide{flex:1}
.value pre{margin:0;padding:4px 0}
.md{padding:6px 0}
.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md-p{margin:0 0 8px}
.md-h{margin:12px 0 6px;font-size:1rem;font-weight:600}
.md-list{margin:0 0 8px;padding-left:24px}
.md-list .md-list{margin:2px 0 0}
.md-code{margin:0 0 8px;padding:8px 10px;background:var(--head);border-radius:4px}
.md-inline-code{background:var(--head);padding:1px 4px;border-radius:3px;font-size:13px}
.md-quote{margin:0 0 8px;padding-left:12px;border-left:3px solid var(--border);color:var(--dim)}
.md-hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.md-table{border-collapse:collapse;margin:0 0 8px}
.md-table th,.md-table td{border:1px solid var(--border);padding:4px 8px;text-align:left}
.md-table th{background:var(--head)}
.scroll{max-height:200px;overflow:auto}
pre{margin:0;font-family:var(--mono);font-size:14px;white-space:pre-wrap;word-break:break-word}
code{font-family:var(--mono);font-size:14px}
.stats{width:100%;border-collapse:collapse;text-align:center;border:1px solid var(--border);font-variant-numeric:tabular-nums}
.stats td{padding:8px}
.stats tr:first-child td{background:var(--head)}
.stats tr+tr td{border-top:1px solid var(--border)}
.stats.small{width:50%;margin:0 auto}
@media (max-width:800px){.stats.small{width:100%}}
.overview{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.overview th,.overview td{border:1px solid var(--border);padding:8px;text-align:left;vertical-align:top}
.overview th{background:var(--head);font-weight:600}
.overview td.name{word-break:break-word}
a{color:var(--link)}
.dim{color:var(--dim)}
.c-passed{color:var(--passed)}.c-failed{color:var(--failed)}.c-errored{color:var(--errored)}.c-skipped{color:var(--skipped)}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin:40px 0 8px}
.toolbar h3{margin:0;font-weight:500;font-size:1.75rem}
.buttons{display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap}
.toolbar.above{margin:40px 0 8px}
.search{flex:1;min-width:200px;max-width:480px;font:inherit;padding:6px 12px;border:1px solid var(--btn);border-radius:6px;background:var(--card);color:var(--text)}
.toolbar h3+.search{margin-left:16px}
.toolbar .buttons{margin-left:auto}
.unmatched{display:none}
.btn{font:inherit;color:var(--btn);background:none;border:1px solid var(--btn);border-radius:6px;padding:6px 12px;cursor:pointer;text-decoration:none;display:inline-block}
.btn:hover{background:var(--btn);color:var(--bg)}
.btn.static{cursor:default}
.btn.static:hover{background:none;color:var(--btn)}
.hidden{display:none}
.tests details.acc{border:1px solid var(--border);border-top:none;background:var(--card)}
.tests details.acc:first-child{border-top:1px solid var(--border);border-radius:6px 6px 0 0}
.tests details.acc:last-child{border-radius:0 0 6px 6px}
.tests details.acc:only-child{border-radius:6px}
details.acc>summary{list-style:none;cursor:pointer;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
details.acc>summary::-webkit-details-marker{display:none}
details.acc[open]>summary{background:var(--open)}
.icon{flex:none;width:18px;height:18px;border-radius:3px;display:inline-grid;place-items:center;font-size:12px;font-weight:800;color:var(--icon-text)}
.icon.passed{background:var(--passed)}.icon.failed{background:var(--failed)}.icon.errored{background:var(--errored)}.icon.skipped{background:var(--skipped)}
.acc-body{padding:16px 20px}
.detail-row{display:flex;justify-content:space-between;gap:16px;padding:6px 0}
.detail-row+.detail-row{border-top:1px solid var(--border)}
.detail-row.head{padding:0}
.ea{font-size:14px;margin-top:2px}
.console .log-warn{color:var(--errored)}.console .log-error{color:var(--failed)}
footer.container{text-align:center;margin:48px auto 0}
.small-print{margin-top:8px;font-size:12px;overflow-wrap:anywhere}
`

const SCRIPT = `
function toggle(button, status, noun) {
  const hide = button.dataset.hidden !== 'true'
  button.dataset.hidden = String(hide)
  button.textContent = (hide ? 'Show ' : 'Hide ') + noun
  for (const el of document.querySelectorAll('tr.' + status + ', details.acc.' + status)) el.classList.toggle('hidden', hide)
}
// The button says what a click will do: Expand All while any test is closed,
// Collapse All once every one is open — however they got that way.
const tests = () => [...document.querySelectorAll('details.acc')]
function syncExpandAll() {
  const button = document.getElementById('expand-all')
  if (button) button.textContent = tests().some((d) => !d.open) ? 'Expand All' : 'Collapse All'
}
function search(input) {
  const query = input.value.trim().toLowerCase()
  for (const el of document.querySelectorAll(input.dataset.target)) {
    el.classList.toggle('unmatched', query !== '' && !el.dataset.search.includes(query))
  }
}
function expandAll() {
  const open = tests().some((d) => !d.open)
  for (const d of tests()) d.open = open
  syncExpandAll()
}
document.addEventListener('DOMContentLoaded', () => {
  for (const d of tests()) d.addEventListener('toggle', syncExpandAll)
  syncExpandAll()
})
`
