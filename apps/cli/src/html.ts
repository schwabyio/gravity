import {
  MARK_GLYPH,
  bodyAsObject,
  buildChecks,
  checkedBody,
  checkedDiffersFromRaw,
  formatPath,
  markHeaders,
  markLines,
  markStatus,
  parseMarkdown,
  parsePath,
  resolvePath,
  resultName,
  sortArraysBy,
  toJsonLines,
  type AssertionResult,
  type BodyLine,
  type Check,
  type EventStreamRead,
  type HeaderEntry,
  type Mark,
  type Marked,
  type MdBlock,
  type MdInline,
  type ReceivedResponse,
  type RunResult,
  type ScriptSource,
  type SentRequest
} from '@schwabyio/gravity-core'
import { iterationName, unattempted, type StepRef } from './job.js'
import type { JUnitCollection, JUnitRun } from './junit.js'
import type { CollectionTally } from './report.js'

/**
 * The run as HTML: a summary page — the result, Settings, Summary Stats with
 * a pass rate for collections, tests and assertions and the total run time,
 * the Results Overview,
 * and what was not run — and a page per collection it links to, with a
 * section per test holding its Request, Response and Assertions. Gravity's
 * palette, light or dark with the system.
 *
 * Request and response each show formatted or raw — raw as the app's Console
 * shows it — and every part of them can be copied. A body is shown as the
 * engine checked it, each line marked by the checks about it as the app marks
 * them. HTML, as a body or as a string in one, renders in a sandboxed frame
 * that runs no script and loads nothing; an image, as a body or as a `data:`
 * string in one, shows as the image, and another binary body can be downloaded.
 *
 * The pages load nothing from the network — no CDN, no fonts — so they open the
 * same from a CI artifact or a machine with no connection, and they name no
 * folder of the machine that ran them. The folder they go in is deleted before
 * each run, so a collection that did not run this time never leaves a page
 * behind.
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
  /** The project folder, for the JSON report: the pages leave it out. */
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

/** A body longer than this is cut in the report; the run saw all of it. */
const BODY_LIMIT = 256 * 1024

/** An image or other binary body bigger than this is left out: its base64 would be most of the page. */
const BINARY_LIMIT = 1024 * 1024

/** Where gta's version, at the foot of every page, leads. */
const REPO_URL = 'https://github.com/schwabyio/gravity'

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

/** How many of each status, in the order a legend lists them. */
type Parts = Array<[Status, number]>

/** Every step skipped: the collection neither passed nor failed, so it is counted on its own. */
const collectionStatus = (t: CollectionTally): Status =>
  t.skipped ? 'skipped' : t.passed ? 'passed' : 'failed'

/* --------------------------------------------------------------- summary -- */

function summaryPage(run: HtmlRun): string {
  const tallies = run.collections.map((c) => c.tally)
  const sum = (pick: (t: CollectionTally) => number) => tallies.reduce((n, t) => n + pick(t), 0)
  const statuses = tallies.map(collectionStatus)
  const count = (status: Status) => statuses.filter((s) => s === status).length
  const passed = count('failed') === 0
  const none = '<span class="dim">none</span>'
  const leftOut = (n: number) => `<a href="#not-run">${plural(n, 'collection')} ↓</a>`

  const settings: Array<[string, string]> = [
    ['Environment', run.environment ? escape(run.environment) : none],
    ['Concurrency Limit', String(run.concurrency)],
    ['Collection Timeout', timeoutText(run.timeoutCollection)],
    ['Tags', run.tags.length > 0 ? escape(run.tags.join(', ')) : none],
    ...(run.notTags?.length
      ? ([['Not Tags', escape(run.notTags.join(', '))]] as Array<[string, string]>)
      : []),
    ['Feature Flags', flagChips(run.flags ?? {}) || none],
    ...(run.flagCommand
      ? ([['Flag Command', `<code>${escape(run.flagCommand)}</code>`]] as Array<[string, string]>)
      : []),
    ...(run.bail ? ([['Bail', 'on']] as Array<[string, string]>) : []),
    ['Excluded', run.excluded.length > 0 ? leftOut(run.excluded.length) : none],
    ...(run.untagged > 0
      ? ([['Left Out By Tags', leftOut(run.untagged)]] as Array<[string, string]>)
      : [])
  ]

  const rows = run.collections
    .map((c, i) => {
      const t = c.tally
      const status = statuses[i]!
      return `<tr class="s-${status}" data-status="${status}" data-search="${escape(c.id.toLowerCase())}"><td class="r n">${i + 1}</td><td class="name"><a href="${escape(encodeURI(pageOf(c.id)))}">${breakable(c.id)}</a></td><td class="r">${duration(c.durationMs)}</td><td class="r gs">${t.steps.total}</td><td class="r">${num(t.steps.passed)}</td><td class="r">${num(t.steps.failed, true)}</td><td class="r">${num(t.steps.errored, true)}</td><td class="r">${num(t.steps.skipped)}</td><td class="r gs">${t.assertions.total}</td><td class="r">${num(t.assertions.passed)}</td><td class="r">${num(t.assertions.failed, true)}</td><td class="gs">${pill(status)}</td></tr>`
    })
    .join('\n')

  const notRun =
    run.excluded.length > 0 || run.untagged > 0
      ? card(
          'Not Run',
          [
            run.excluded.length > 0
              ? `<h3 class="group-h">Excluded <span class="dim">· ${run.excluded.length} · <code>exclude: true</code> in the collection file</span></h3>
<ul class="excluded">${run.excluded.map((id) => `<li>${escape(id)}</li>`).join('')}</ul>`
              : '',
            run.untagged > 0
              ? `<h3 class="group-h">Left out by tags <span class="dim">· ${plural(run.untagged, 'collection')}</span></h3>`
              : ''
          ].join('\n'),
          { id: 'not-run' }
        )
      : ''

  return page({
    title: `${passed ? 'PASSED' : 'FAILED'} · ${run.project} · gta Summary Results`,
    run,
    body: `${pageHead(passed ? 'passed' : 'failed', `${escape(run.project)} <span class="kind">· Summary Results</span>`, run.startedAt)}

${card('Settings', `<dl class="pairs">\n${settings.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('\n')}\n</dl>`)}

${card(
  'Summary Stats',
  `<div class="stats">
${ringStat('Collections', [
  ['passed', count('passed')],
  ['failed', count('failed')],
  ['skipped', count('skipped')]
])}
${ringStat('Tests', [
  ['passed', sum((t) => t.steps.passed)],
  ['failed', sum((t) => t.steps.failed)],
  ['errored', sum((t) => t.steps.errored)],
  ['skipped', sum((t) => t.steps.skipped)]
])}
${ringStat('Assertions', [
  ['passed', sum((t) => t.assertions.passed)],
  ['failed', sum((t) => t.assertions.failed)]
])}
${timeStat('Total Run Time', run.durationMs)}
</div>`
)}

${card(
  'Results Overview',
  `<div class="scroll-x"><table class="overview">
<thead><tr class="groups"><th colspan="3"></th><th colspan="5" class="gs">Tests</th><th colspan="3" class="gs">Assertions</th><th class="gs"></th></tr>
<tr><th class="r">#</th><th>Collection ID</th><th class="r">Run Time</th><th class="r gs">Total</th><th class="r">Passed</th><th class="r">Failed</th><th class="r">Errored</th><th class="r">Skipped</th><th class="r gs">Total</th><th class="r">Passed</th><th class="r">Failed</th><th class="gs">Result</th></tr></thead>
<tbody>
${rows}
</tbody></table></div>`,
  {
    flush: true,
    tools: `${chips({ passed: count('passed'), failed: count('failed'), skipped: count('skipped') })}${searchBox('Search collections')}`
  }
)}
${notRun}`
  })
}

/* ------------------------------------------------------------ collection -- */

function collectionPage(run: HtmlRun, c: HtmlCollection): string {
  const t = c.tally
  const status = collectionStatus(t)
  const results = c.outcome.ok ? c.outcome.summary.results : []
  const tests = !c.outcome.ok
    ? ''
    : [
        ...results.map((r, i) => testSection(r, i, c.outcome.ok ? c.outcome.steps[i] : undefined)),
        unattempted(c.outcome.summary) > 0 ? notRunSection(unattempted(c.outcome.summary)) : ''
      ].join('\n')
  const groups = results.map((r) => group(statusOf(r)))
  const data = c.outcome.ok ? c.outcome.data : null

  return page({
    title: `${status.toUpperCase()} · ${c.id} · gta Collection Results`,
    run,
    body: `<nav class="crumbs"><a href="${SUMMARY_PAGE}">Summary</a><span aria-hidden="true">/</span><span>${escape(c.id)}</span></nav>
${pageHead(status, escape(c.id), c.startedAt, c.durationMs)}

${card(
  'Results Overview',
  [
    c.docs?.trim() ? markdown(c.docs) : '',
    data
      ? `<dl class="pairs"><div><dt>Data File</dt><dd><code>${escape(data.file)}</code></dd></div><div><dt>Iterations</dt><dd>${data.rows}</dd></div></dl>`
      : '',
    !c.outcome.ok
      ? `<section class="sub problem"><h3>Error</h3><pre>${escape(c.outcome.message)}</pre></section>`
      : '',
    `<div class="stats">
${ringStat('Tests', [
  ['passed', t.steps.passed],
  ['failed', t.steps.failed],
  ['errored', t.steps.errored],
  ['skipped', t.steps.skipped]
])}
${ringStat('Assertions', [
  ['passed', t.assertions.passed],
  ['failed', t.assertions.failed]
])}
</div>`
  ]
    .filter(Boolean)
    .join('\n'),
  { tools: `<code class="file">${escape(c.file)}</code>` }
)}

<div class="toolbar"><h2>Tests</h2>${groups.length > 0 ? searchBox('Search tests') : ''}<div class="tools-end">${chips(
      {
        passed: groups.filter((g) => g === 'passed').length,
        failed: groups.filter((g) => g === 'failed').length,
        skipped: groups.filter((g) => g === 'skipped').length
      }
    )}${
      groups.length === 0
        ? ''
        : // Says what a click does: expand while any test is closed, as passed and skipped ones start.
          `<button type="button" class="btn" id="expand-all">${groups.some((g) => g !== 'failed') ? 'Expand All' : 'Collapse All'}</button>`
    }</div></div>
<div class="tests">
${tests || '<p class="dim empty">No tests were run.</p>'}
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

/** What a filter chip counts it as: an errored test is what a failed run is made of too. */
const group = (status: Status): 'passed' | 'failed' | 'skipped' =>
  status === 'errored' ? 'failed' : status

function testSection(r: RunResult, index: number, ref: StepRef | undefined): string {
  const status = statusOf(r)
  const named = iterationName(resultName(r), ref)
  const name = r.use
    ? `${escape(named)} <span class="dim">(${escape(r.use.set)} ${r.use.child + 1}/${r.use.of})</span>`
    : escape(named)
  const method = r.request.method.toUpperCase()
  const res = r.response
  const outcome = r.skipped
    ? '<span class="dim">skipped</span>'
    : res
      ? `${statusCode(res)}<span class="dim">${duration(res.timings.totalMs)}</span>`
      : '<span class="c-failed">no response</span>'
  const id = `t${index + 1}`
  // A skipped step sent nothing: the reason — a feature flag, gta.skip — is all there is to show.
  const body = r.skipped
    ? `<p class="skip-reason">${escape(r.skipped.reason)} — this test was not run</p>`
    : [
        r.error ? errorSection(r) : '',
        requestSection(r.request),
        responseSection(r, id),
        assertionsSection(r.assertions),
        r.logs?.length ? consoleSection(r) : ''
      ]
        .filter(Boolean)
        .join('\n')
  // What the search matches: the name as shown, iteration and all.
  return `<details class="test s-${status}" id="${id}" data-status="${group(status)}" data-search="${escape(named.toLowerCase())}"${status === 'passed' || status === 'skipped' ? '' : ' open'}>
<summary><span class="n">${index + 1}</span><span class="method ${methodClass(method)}">${escape(method)}</span><span class="name">${name}</span><span class="res">${outcome}${mark(status)}<span class="chev" aria-hidden="true">▶</span></span></summary>
<div class="test-body">
${body}
</div>
</details>`
}

function notRunSection(count: number): string {
  return `<details class="test s-skipped" data-status="skipped" data-search="">
<summary><span class="n"></span><span class="name">${plural(count, 'test')} not run</span><span class="res">${mark('skipped')}<span class="chev" aria-hidden="true">▶</span></span></summary>
<div class="test-body"><p class="skip-reason">The collection stopped at its first failure (bail), so ${count === 1 ? 'this test was' : 'these tests were'} not run.</p></div>
</details>`
}

function errorSection(r: RunResult): string {
  const e = r.error!
  const where = [e.script && `${e.script} script`, e.line && `line ${e.line}`]
    .filter(Boolean)
    .join(', ')
  const detail = e.stack ? `\n\n${userFrames(e.stack)}` : ''
  return `<section class="sub problem"><h3>${escape(capitalise(e.phase))} Error</h3><pre>${escape(`${where ? `(${where}) ` : ''}${e.message}${detail}`)}</pre></section>`
}

/* ---------------------------------------------------- request, response -- */

/** As the app's Console shows it: method and URL, headers, a blank line, then the body. */
function rawRequest(request: SentRequest): string {
  const head = [`${request.method} ${request.url}`, ...request.headers.map(headerLine)].join('\n')
  return request.body ? `${head}\n\n${request.body}` : head
}

/** As the app's Console shows it: status, headers, a blank line, then the body. */
function rawResponse(response: ReceivedResponse): string {
  const head = [
    `${response.status} ${response.statusText}`.trim(),
    ...response.headers.map(headerLine)
  ].join('\n')
  // Bytes kept as base64 are not text to show: say what there was instead.
  const body =
    response.bodyEncoding === 'base64'
      ? `[binary body, ${bytes(response.sizeBytes)}]`
      : response.body
  return body ? `${head}\n\n${body}` : head
}

const headerLine = (header: HeaderEntry) => `${header.name}: ${header.value}`

/**
 * A request or response, formatted or raw. Every Copy reads the raw text, the
 * one copy of each part the page holds, so the copies are what was sent or
 * received rather than how it is shown.
 */
const exchange = (title: string, formatted: string, raw: string, rawNote: string, rawId = '') =>
  `<section class="sub" data-switch data-exchange>
<div class="sub-h"><h3>${title}</h3><span class="seg" role="group" aria-label="${title} view"><button type="button" data-show="formatted" aria-pressed="true">Formatted</button><button type="button" data-show="raw" aria-pressed="false">Raw</button></span></div>
<div data-part="formatted">
${formatted}
</div>
<div data-part="raw" hidden>${part(title === 'Request' ? 'As sent' : 'As received', rawNote, copyButton('raw'), `<pre class="raw" data-raw${rawId ? ` id="${rawId}"` : ''}>${escape(clip(raw))}</pre>`)}</div>
</section>`

function requestSection(request: SentRequest): string {
  const { headers, body } = request
  const missing = [headers.length === 0 && 'no headers', !body && 'no body'].filter(Boolean)
  const formatted = [
    `<div class="line"><span class="method ${methodClass(request.method)}">${escape(request.method.toUpperCase())}</span><code class="url">${escape(request.url || '—')}</code>${request.url ? copyButton('url', 'Copy URL') : ''}</div>`,
    headers.length > 0
      ? part('Headers', String(headers.length), copyButton('headers'), headerTable(headers))
      : '',
    body
      ? part(
          'Body',
          [headerValue(headers, 'content-type'), bytes(Buffer.byteLength(body))]
            .filter(Boolean)
            .map((s) => escape(s!))
            .join(' · '),
          copyButton('body'),
          codeView(requestBodyLines(body), false)
        )
      : '',
    missing.length > 0 ? `<p class="dim small none">${capitalise(missing.join(' · '))}</p>` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return exchange(
    'Request',
    formatted,
    rawRequest(request),
    'method and URL, headers, a blank line, then the body'
  )
}

/** A request body as sent: pretty when it is JSON, its own lines when not. */
function requestBodyLines(body: string): Line[] {
  if (/^\s*[{[]/.test(body)) {
    try {
      return toJsonLines(JSON.parse(body)).map((line) => ({
        text: line.text,
        html: highlightJson(line.text)
      }))
    } catch {
      // Not JSON after all: shown as written.
    }
  }
  return body.split('\n').map((text) => ({ text, html: escape(text) }))
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

function responseSection(r: RunResult, id: string): string {
  const res = r.response
  if (!res) {
    return `<section class="sub"><h3>Response</h3><p class="c-failed none">No response was received.</p></section>`
  }
  const checks = buildChecks(r.assertions)
  const status = markStatus(checks).mark
  const extra = [
    `first byte ${duration(res.timings.ttfbMs)}`,
    bytes(res.sizeBytes),
    res.redirectCount > 0 ? plural(res.redirectCount, 'redirect') : '',
    res.stream
      ? `${plural(res.stream.at.length, 'event')}, ${ENDED_BY[res.stream.endedBy]}${connectionNote(res.stream)}`
      : ''
  ].filter(Boolean)
  const formatted = [
    `<div class="line">${statusCode(res)}${status ? `<span class="mk-inline mk-${status}" title="${status === 'fail' ? 'A status check failed' : 'Status checked'}">${MARK_GLYPH[status]}</span>` : ''}<span class="dim small">${duration(res.timings.totalMs)} · ${escape(extra.join(' · '))}</span></div>`,
    res.headers.length > 0
      ? part(
          'Headers',
          String(res.headers.length),
          copyButton('headers'),
          headerTable(res.headers, markHeaders(res.headers, checks))
        )
      : '',
    responseBody(r, res, checks, id)
  ]
    .filter(Boolean)
    .join('\n')
  return exchange(
    'Response',
    formatted,
    rawResponse(res),
    'status, headers, a blank line, then the body',
    `${id}-raw`
  )
}

/**
 * The body as the engine checked it, as the app shows it: XML converted, an
 * event stream read as its events, arrays sorted as the tests sorted them, and
 * each line marked by the checks about it. HTML renders; Source shows its lines.
 */
function responseBody(r: RunResult, res: ReceivedResponse, checks: Check[], id: string): string {
  if (res.bodyKind === 'empty') return '<p class="dim small none">Empty body</p>'
  const rawId = `${id}-raw`
  const type = headerValue(res.headers, 'content-type') ?? res.bodyKind
  const how = checkedDiffersFromRaw(res, r.sortedBy)
    ? [
        res.bodyKind === 'xml' ? 'converted from XML' : '',
        res.bodyKind === 'events' ? 'read as events' : '',
        r.sortedBy?.length ? `sorted by ${r.sortedBy.join(', ')}` : ''
      ].filter(Boolean)
    : []
  const meta = escape([type, bytes(res.sizeBytes), ...how].join(' · '))
  if (res.bodyEncoding === 'base64') return binaryBody(res, meta, id)
  const copy = copyButton('body')
  const checked = checkedBody(res, r.sortedBy)
  if (!checked.ok) {
    // A binary type whose bytes are text has no properties; that is no failure.
    return part(
      'Body',
      meta,
      copy,
      `<p class="${res.bodyKind === 'binary' ? 'dim' : 'c-failed'} small pad">${escape(checked.message)}</p><pre class="raw">${escape(clip(res.body))}</pre>`
    )
  }

  const ignored = (r.ignored ?? []).map((entry) => parsePath(entry.path))
  const marks = markLines(checked.lines, checks, ignored)
  const structured = res.bodyKind !== 'text' && res.bodyKind !== 'html'
  const value = structured ? checkedValue(res, r.sortedBy) : undefined
  // A failed check's message goes beside the first line it marks, once.
  const noted = new Set<number>()
  const lines = checked.lines.map((line, i): Line => {
    const marked = marks[i]!
    const failing =
      marked.mark === 'fail'
        ? marked.about.filter((k) => checks[k]!.assertion.status === 'fail' && !noted.has(k))
        : []
    for (const k of failing) noted.add(k)
    const note = failing.length
      ? `<span class="note">${MARK_GLYPH.fail} ${escape(failing.map((k) => checks[k]!.assertion.message ?? checks[k]!.assertion.name).join('; '))}</span>`
      : ''
    const viewer = value === undefined ? null : stringViewer(value, line, `${rawId}-v${i}`)
    return {
      text: line.text,
      html: viewer?.html ?? (structured ? highlightJson(line.text) : escape(line.text)),
      mark: marked.mark,
      note: `${viewer?.button ?? ''}${note}`,
      after: viewer?.panel
    }
  })
  const view = codeView(lines, true)

  if (res.bodyKind === 'html') {
    return part(
      'Body',
      meta,
      `${renderSwitch()}${copy}`,
      `<div data-part="rendered">${htmlFrame(rawId, true, 'The response body, rendered')}</div>
<div data-part="source" hidden>${view}</div>`,
      true
    )
  }
  return part('Body', meta, copy, view)
}

/**
 * A body whose bytes the results keep as base64: an image shown as itself,
 * anything else offered to download as it came. One too big is left out.
 */
function binaryBody(res: ReceivedResponse, meta: string, id: string): string {
  const type = (headerValue(res.headers, 'content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (res.sizeBytes > BINARY_LIMIT) {
    return part(
      'Body',
      meta,
      '',
      `<p class="dim small pad">Over ${bytes(BINARY_LIMIT)}, too big to put in the report.</p>`
    )
  }
  const uri = escape(`data:${type || 'application/octet-stream'};base64,${res.body}`)
  if (type.startsWith('image/')) {
    return part(
      'Body',
      meta,
      copyButton('image', 'Copy data URI'),
      `<div class="img-view"><span class="checker"><img loading="lazy" src="${uri}" alt="The response body"></span><span class="dim small"><span data-dims></span>${escape(type)}</span></div>`
    )
  }
  const subtype = type.split('/')[1] ?? ''
  const extension = /^[a-z0-9]{1,8}$/.test(subtype) ? subtype : 'bin'
  return part(
    'Body',
    meta,
    `<a class="btn sm" href="${uri}" download="${id}-body.${extension}">Download</a>`,
    '<p class="dim small pad">Binary, so not shown as text. Download saves it as it came.</p>'
  )
}

/** The checked body as a value, to find the string a line shows. */
function checkedValue(res: ReceivedResponse, sortedBy: string[] | undefined): unknown {
  const parsed = bodyAsObject(res)
  if (!parsed.ok) return undefined
  return sortedBy ? sortArraysBy(parsed.body, sortedBy) : parsed.body
}

/**
 * A View button for a string that holds HTML or a `data:` image, and the panel
 * it opens under the line. A data URI is shortened on its line; Raw and Copy
 * keep all of it.
 */
function stringViewer(
  value: unknown,
  line: BodyLine,
  id: string
): { html?: string; button: string; panel: string } | null {
  if (line.path.length === 0 || !/"[,]?$/.test(line.text)) return null
  const found = resolvePath(value, line.path)[0]?.value
  if (typeof found !== 'string') return null
  const path = formatPath(line.path)
  const close = `<button type="button" class="btn sm" data-close="${id}">Close</button>`
  if (DATA_IMAGE.test(found)) {
    const literal = JSON.stringify(found)
    const at = line.text.lastIndexOf(literal)
    const shown = `${line.text.slice(0, at)}${JSON.stringify(`${found.slice(0, 40)}…`)}${line.text.slice(at + literal.length)}`
    const comma = found.indexOf(',')
    const size =
      Math.floor(((found.length - comma - 1) * 3) / 4) - (found.match(/=+$/)?.[0].length ?? 0)
    return {
      html: `${highlightJson(shown)}<span class="dim"> (${bytes(found.length)})</span>`,
      button: `<button type="button" class="peek" data-peek="${id}" aria-expanded="false">View image</button>`,
      panel: `<div class="peek-row" id="${id}" hidden><div class="peek-panel">
<div class="peek-h"><code>${escape(path)}</code><span class="dim">${escape(found.slice(5, found.indexOf(';')))} · <span data-dims></span>${bytes(size)}</span><span class="end"><button type="button" class="btn sm" data-copy="image">Copy data URI</button>${close}</span></div>
<div class="img-view"><span class="checker"><img loading="lazy" src="${escape(found)}" alt="The image at ${escape(path)}"></span></div>
</div></div>`
    }
  }
  if (looksLikeHtml(found)) {
    return {
      button: `<button type="button" class="peek" data-peek="${id}" aria-expanded="false">View HTML</button>`,
      panel: `<div class="peek-row" id="${id}" hidden><div class="peek-panel" data-switch>
<div class="peek-h"><code>${escape(path)}</code><span class="dim">HTML · ${bytes(Buffer.byteLength(found))}</span><span class="end">${renderSwitch()}<button type="button" class="btn sm" data-copy="source">Copy</button>${close}</span></div>
<div data-part="rendered">${htmlFrame(`${id}-source`, false, `The HTML at ${path}, rendered`)}</div>
<pre class="raw" data-part="source" id="${id}-source" hidden>${escape(found)}</pre>
</div></div>`
    }
  }
  return null
}

/** Only base64 an `<img>` can take as it is. */
const DATA_IMAGE = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+/]+=*$/

/** Starts with a tag and closes one: markup, as against text that has a `<` in it. */
const looksLikeHtml = (text: string): boolean =>
  /^\s*<(!doctype\s+html|[a-z][a-z0-9-]*)[\s>/]/i.test(text) && /<\/[a-z][a-z0-9-]*\s*>/i.test(text)

/**
 * HTML shown in a frame with no permissions: its scripts do not run, it cannot
 * reach the page, and the policy the page's script puts before it lets it load
 * nothing. The page fills it from `from` once it is shown.
 */
const htmlFrame = (from: string, body: boolean, title: string) =>
  `<div class="html-frame"><iframe sandbox="" title="${escape(title)}" data-from="${from}"${body ? ' data-body' : ''}></iframe></div><p class="frame-note">Sandboxed: scripts don't run, and nothing loads from the network.</p>`

const renderSwitch = () =>
  '<span class="seg" role="group" aria-label="HTML view"><button type="button" data-show="rendered" aria-pressed="true">Rendered</button><button type="button" data-show="source" aria-pressed="false">Source</button></span>'

function headerTable(headers: HeaderEntry[], marks?: Marked[]): string {
  const anyMarked = marks?.some((m) => m.mark !== null) ?? false
  return `<table class="kv">${headers
    .map((h, i) => {
      const mark = marks?.[i]?.mark ?? null
      return `<tr${mark ? ` class="mk-${mark}"` : ''}>${anyMarked ? `<td class="mk">${mark ? MARK_GLYPH[mark] : ''}</td>` : ''}<td class="k">${escape(h.name)}</td><td>${escape(h.value)}</td></tr>`
    })
    .join('')}</table>`
}

/* ------------------------------------------------------------ assertions -- */

function assertionsSection(assertions: AssertionResult[]): string {
  const failed = assertions.filter((a) => a.status === 'fail').length
  const head = `<h3>Assertions <span class="dim">${assertions.length} · ${assertions.length - failed} passed · ${failed} failed</span></h3>`
  if (assertions.length === 0)
    return `<section class="sub">${head}<p class="dim small none">No assertions.</p></section>`
  const items = assertions.map((a) => {
    const failing = a.status === 'fail'
    const detail = [
      a.message ? `<div class="check-msg">${escape(a.message)}</div>` : '',
      failing && (a.expected !== undefined || a.actual !== undefined)
        ? `<dl class="ea">${a.expected !== undefined ? `<dt>expected</dt><dd><code>${escape(a.expected)}</code></dd>` : ''}${a.actual !== undefined ? `<dt>actual</dt><dd><code>${escape(a.actual)}</code></dd>` : ''}</dl>`
        : '',
      a.unasserted?.length
        ? `<dl class="ea"><dt>not asserted</dt><dd><code>${escape(a.unasserted.join(', '))}</code></dd></dl>`
        : ''
    ].join('')
    const status: Status = failing ? 'failed' : 'passed'
    return `<li class="s-${status}">${mark(status)}<div class="check"><div class="check-name">${escape(a.name)}</div>${detail}</div>${a.source ? `<span class="src">${escape(sourceText(a.source))}</span>` : ''}</li>`
  })
  return `<section class="sub">${head}<ul class="checks">
${items.join('\n')}
</ul></section>`
}

/** Where a check was made, as `tests:4`: the step's own tests, or whose they were. */
const sourceText = (source: ScriptSource): string =>
  `${source.script === 'step' ? 'tests' : `${source.script} tests`}:${source.line}${source.check ? ` · ${source.check.file}:${source.check.line}` : ''}`

function consoleSection(r: RunResult): string {
  const lines = r.logs!.map(
    (l) =>
      `<span class="log-${l.level}">[${escape(l.phase)} ${l.level}] ${escape(l.message)}</span>`
  )
  return `<section class="sub"><h3>Console</h3><pre class="console">${lines.join('\n')}</pre></section>`
}

/* ------------------------------------------------------------------ code -- */

/** A line of a body: its text, how it is shown, and what is beside and under it. */
interface Line {
  text: string
  html: string
  mark?: Mark | null
  /** After the text: a View button, a failed check's message. */
  note?: string
  /** Under the line: the panel its View button opens. */
  after?: string | undefined
}

/** Numbered lines, with a column for the checks' marks when `marked`. */
function codeView(all: Line[], marked: boolean): string {
  const { lines, more } = cutLines(all)
  const rows = lines.map(
    (line, i) =>
      `<div class="ln${line.mark ? ` mk-${line.mark}` : ''}"><span class="no">${i + 1}</span>${marked ? `<span class="mk" aria-hidden="true">${line.mark ? MARK_GLYPH[line.mark] : ''}</span>` : ''}<span class="tx">${line.html}${line.note ?? ''}</span></div>${line.after ?? ''}`
  )
  if (more > 0) {
    rows.push(
      `<div class="ln cut"><span class="no"></span><span class="tx">… ${bytes(more)} more not shown</span></div>`
    )
  }
  return `<div class="codeview">${rows.join('\n')}</div>`
}

/** As many lines as `BODY_LIMIT` holds, the last one cut to fit, and how much is left. */
function cutLines(lines: Line[]): { lines: Line[]; more: number } {
  let left = BODY_LIMIT
  for (let i = 0; i < lines.length; i++) {
    const length = lines[i]!.text.length + 1
    if (length > left) {
      const total = lines.reduce((n, line) => n + line.text.length + 1, 0) - 1
      const kept = lines.slice(0, i)
      const cut = lines[i]!.text.slice(0, left)
      if (cut) kept.push({ text: cut, html: escape(cut) })
      return { lines: kept, more: total - BODY_LIMIT }
    }
    left -= length
  }
  return { lines, more: 0 }
}

/** One line of pretty-printed JSON, its key, string, number and literal each coloured. */
function highlightJson(text: string): string {
  const match = /^(\s*)("(?:[^"\\]|\\.)*": )?(.*?)(,?)$/.exec(text)
  if (!match) return escape(text)
  const [, indent = '', key, value = '', comma = ''] = match
  const kind = value.startsWith('"')
    ? 'j-s'
    : /^-?\d/.test(value)
      ? 'j-n'
      : /^(true|false|null)$/.test(value)
        ? 'j-l'
        : ''
  return `${indent}${key ? `<span class="j-k">${escape(key.slice(0, -2))}</span>: ` : ''}${kind ? `<span class="${kind}">${escape(value)}</span>` : escape(value)}${comma}`
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
<main class="page">
${options.body}
<footer class="foot">Generated by <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="Gravity Test Automation on GitHub">gta ${escape(options.run.version)} <span aria-hidden="true">↗</span></a></footer>
</main>
</body>
</html>
`
}

/** The result and the title, when it ran, and how long it took: the summary says that in its stats. */
const pageHead = (status: Status, title: string, startedAt: number, ms?: number) =>
  `<header class="head"><div class="title">${pill(status, true)}<h1>${title}</h1></div><div class="meta"><span>${escape(timeOfRun(startedAt))}</span>${ms === undefined ? '' : `<span>${duration(ms)}</span>`}</div></header>`

const card = (
  title: string,
  body: string,
  options: { id?: string; tools?: string; flush?: boolean } = {}
) =>
  `<section class="card"${options.id ? ` id="${options.id}"` : ''}><div class="card-h"><h2>${title}</h2>${options.tools ?? ''}</div><div class="card-body${options.flush ? ' flush' : ''}">
${body}
</div></section>`

/** A part of a request or response: a titled box with its own tools, Copy among them. */
const part = (title: string, meta: string, tools: string, body: string, switches = false) =>
  `<div class="part"${switches ? ' data-switch' : ''}><div class="part-h"><span>${title}</span><span class="dim">${meta}</span><span class="end">${tools}</span></div>${body}</div>`

/** `url`, `headers`, `body` or `raw` of the request or response it is in; `source` of a viewer; `image`, the one beside it. */
const copyButton = (what: string, label = 'Copy') =>
  `<button type="button" class="btn sm" data-copy="${what}">${label}</button>`

const pill = (status: Status, solid = false) =>
  `<span class="pill${solid ? ' solid' : ''} s-${status}">${status}</span>`

const MARKS: Record<Status, string> = { passed: '✓', failed: '✕', errored: '!', skipped: '⊘' }
const mark = (status: Status) =>
  `<span class="mark s-${status}" role="img" aria-label="${status}">${MARKS[status]}</span>`

/** A count in the overview: a zero fades, a failure stands out. */
const num = (n: number, bad = false) =>
  n === 0 ? '<span class="zero">0</span>' : bad ? `<span class="hot">${n}</span>` : String(n)

/** Coloured by class, as the app colours a status: 2xx, 3xx, 4xx, 5xx. */
function statusCode(res: ReceivedResponse): string {
  const kind =
    res.status >= 500
      ? 'server'
      : res.status >= 400
        ? 'client'
        : res.status >= 300
          ? 'redirect'
          : 'ok'
  return `<span class="status-code k-${kind}">${escape(`${res.status} ${res.statusText}`.trim())}</span>`
}

/** The app's colour for a method; one it has none for keeps the text's. */
const methodClass = (method: string) => `m-${method.toLowerCase().replace(/[^a-z]/g, '')}`

/**
 * A ring of the parts, and the pass rate in it: of what ran, so skipped is
 * left out. Never 100% while anything failed, as the rate rounds down.
 */
function ringStat(label: string, parts: Parts): string {
  const total = parts.reduce((n, [, v]) => n + v, 0)
  const passed = parts.find(([s]) => s === 'passed')?.[1] ?? 0
  const ran = total - (parts.find(([s]) => s === 'skipped')?.[1] ?? 0)
  const rate = ran === 0 ? '—' : `${Math.floor((passed / ran) * 100)}%`
  return `<div class="stat"><div class="ring" title="${thousands(passed)} of ${thousands(ran)} that ran passed">${ring(parts)}<b>${rate}</b></div><div><div class="stat-label">${label}</div><div class="stat-total">${thousands(total)}</div><div class="legend">${parts
    .map(([s, v]) => `<span class="${v ? `s-${s}` : 'zero'}"><i></i>${thousands(v)} ${s}</span>`)
    .join('')}</div></div></div>`
}

/**
 * A time beside the rings, a clock where their ring is: said in words, exact on
 * hover, each number kept with its unit so a narrow tile wraps between them.
 */
const timeStat = (label: string, ms: number): string =>
  `<div class="stat"><div class="ring clock">${clock}</div><div><div class="stat-label">${label}</div><div class="stat-time" title="${thousands(Math.round(ms))} ms">${runTime(ms).replace(/(\d) /g, '$1&nbsp;')}</div></div></div>`

const clock = `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true"><circle cx="32" cy="32" r="25" fill="none" stroke-width="7" style="stroke:var(--surface-alt)"/><path d="M32 19v13l9 6" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--dim)"/></svg>`

/** Each part an arc of the ring, a small gap between, and none too small to see. */
function ring(parts: Parts): string {
  const R = 25
  const C = 2 * Math.PI * R
  const live = parts.filter(([, v]) => v > 0)
  const total = live.reduce((n, [, v]) => n + v, 0)
  const track = `<circle cx="32" cy="32" r="${R}" fill="none" stroke-width="7" style="stroke:var(--surface-alt)"/>`
  if (total === 0)
    return `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">${track}</svg>`
  const gap = live.length > 1 ? 2 : 0
  const lengths = live.map(([, v]) => Math.max((v / total) * C, 5))
  const biggest = lengths.indexOf(Math.max(...lengths))
  lengths[biggest]! -= lengths.reduce((a, b) => a + b, 0) - C
  let offset = 0
  const arcs = live.map(([s], i) => {
    const length = lengths[i]!
    const arc = `<circle class="s-${s}" cx="32" cy="32" r="${R}" fill="none" stroke-width="7" style="stroke:var(--s)" stroke-dasharray="${(length - gap).toFixed(2)} ${(C - length + gap).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 32 32)"/>`
    offset += length
    return arc
  })
  return `<svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">${track}${arcs.join('')}</svg>`
}

const flagChips = (flags: Record<string, string | number | boolean>): string =>
  Object.entries(flags)
    .map(([name, value]) => `<code class="flag">${escape(`${name}=${value}`)}</code>`)
    .join('')

/** Passed / Failed / Skipped, each shown or hidden by a click, and each only when there is one. */
const chips = (counts: Record<'passed' | 'failed' | 'skipped', number>): string =>
  (['passed', 'failed', 'skipped'] as const)
    .filter((s) => counts[s] > 0)
    .map(
      (s) =>
        `<button type="button" class="chip s-${s}" data-hide="${s}" aria-pressed="true" title="Show or hide ${s}">${mark(s)}${capitalise(s)} <b>${counts[s]}</b></button>`
    )
    .join('')

/**
 * A search box that narrows the summary's rows, or a page's tests, to those
 * whose `data-search` holds what is typed. It works alongside the chips: a row
 * shows only when neither hides it.
 */
const searchBox = (label: string) =>
  `<input type="search" class="search" placeholder="${label}" aria-label="${label}">`

const headerValue = (headers: HeaderEntry[], name: string): string | undefined =>
  headers.find((h) => h.name.toLowerCase() === name)?.value

function clip(text: string): string {
  return text.length > BODY_LIMIT
    ? `${text.slice(0, BODY_LIMIT)}\n… ${bytes(text.length - BODY_LIMIT)} more not shown`
    : text
}

/** A script error's stack without gta's own frames. */
const userFrames = (stack: string): string =>
  stack
    .split('\n')
    .filter((line) => !/^\s+at .*(\bnode:|file:\/\/)/.test(line))
    .join('\n')

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** `12,345`: a count with its thousands marked, as the stats show one. */
const thousands = (n: number): string => n.toLocaleString('en-US')

/** `381 ms`, or `1.72 s` from a second up. */
const duration = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`

/**
 * `1 minute 30.61 seconds`, `2 hours 5.00 seconds`, `0.38 seconds`: a run's
 * time in words, as xrun said it, to the hundredth of a second. A unit with
 * none of it is left out.
 */
export function runTime(ms: number): string {
  const hundredths = Math.round(ms / 10)
  const hours = Math.floor(hundredths / 360_000)
  const minutes = Math.floor((hundredths % 360_000) / 6_000)
  const seconds = hundredths % 6_000
  return [
    hours > 0 ? plural(hours, 'hour') : '',
    minutes > 0 ? plural(minutes, 'minute') : '',
    seconds > 0 || hundredths < 6_000 ? `${(seconds / 100).toFixed(2)} seconds` : ''
  ]
    .filter(Boolean)
    .join(' ')
}

/** `3,600,000 ms · 1 h`: the setting as written, and what it comes to when that is round. */
function timeoutText(ms: number): string {
  const round =
    ms >= 3_600_000 && ms % 3_600_000 === 0
      ? `${ms / 3_600_000} h`
      : ms >= 60_000 && ms % 60_000 === 0
        ? `${ms / 60_000} min`
        : ms >= 1000 && ms % 1000 === 0
          ? `${ms / 1000} s`
          : ''
  return `${ms.toLocaleString('en-US')} ms${round ? ` <span class="dim">· ${round}</span>` : ''}`
}

/** `Sun, Oct 4, 2026 · 12:08:20 PM PDT`, in the time zone of the machine that ran it. */
const timeOfRun = (epochMs: number): string => {
  const at = new Date(epochMs)
  return `${at.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })} · ${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' })}`
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * Escaped, and free to wrap after each `_`, `/`, `.` or `-`: a long collection
 * id, `XTEST_DEMO_EXPECT_RESPONSE_…`, has no space to wrap at otherwise.
 */
const breakable = (value: string): string => escape(value).replace(/([_/.-])/g, '$1<wbr>')

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
 * Gravity's palette — the app's surfaces, status-code and method colours —
 * with green, red, amber and blue for passed, failed, errored and skipped,
 * written out here so nothing is fetched. Light or dark with the system.
 */
const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--surface-alt:#eef0f4;--border:#d6dae2;--border-soft:#e6e9ee;--text:#16181d;--dim:#6a7280;--faint:#9aa1ad;--accent:#2f6df6;--link:#1f5fd6;--passed:#107a48;--failed:#cc1f43;--errored:#a65f00;--skipped:#0b7fb8;--on-status:#fff;--ok:#107a48;--redirect:#8a6100;--client:#b23c17;--server:#a01a2b;--m-get:#1f5fd6;--m-post:#0b7a43;--m-put:#946200;--m-patch:#0b7f84;--m-delete:#c42b2b;--m-head:#7c45d0;--m-options:#3f5f80;--j-key:#7c45d0;--j-str:#8a5a2b;--j-num:#0b7f84;--j-lit:#946200;--canvas:#fff;--check-a:#fff;--check-b:#eceef2;--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",sans-serif;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#11131a;--surface:#171a22;--surface-alt:#1e222c;--border:#2b303c;--border-soft:#232733;--text:#e6e8ee;--dim:#949bab;--faint:#666e7e;--accent:#5b8cff;--link:#6b9bff;--passed:#46c98a;--failed:#ff5b78;--errored:#f2a93b;--skipped:#56c2ee;--on-status:#11131a;--ok:#46c98a;--redirect:#e0b24d;--client:#f08a5d;--server:#f0607a;--m-get:#6b9bff;--m-post:#4fd08f;--m-put:#eab54e;--m-patch:#4fd1d1;--m-delete:#ff6f6f;--m-head:#b991ff;--m-options:#8fb4dc;--j-key:#b991ff;--j-str:#d9a066;--j-num:#4fd1d1;--j-lit:#eab54e;--check-a:#262b36;--check-b:#1d212a}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.page{max-width:1320px;margin:0 auto;padding:28px clamp(16px,3vw,32px) 24px}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
code,pre{font-family:var(--mono);font-size:12.5px}
pre{margin:0;white-space:pre-wrap;word-break:break-word}
.dim{color:var(--dim)}
.small{font-size:12.5px}
.hidden,.unmatched{display:none!important}
.s-passed{--s:var(--passed)}.s-failed{--s:var(--failed)}.s-errored{--s:var(--errored)}.s-skipped{--s:var(--skipped)}
.c-failed{color:var(--failed)}
.crumbs{display:flex;flex-wrap:wrap;gap:4px 8px;font-size:13px;color:var(--dim);margin-bottom:10px;overflow-wrap:anywhere}
.head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 24px;margin-bottom:18px}
.title{display:flex;align-items:center;gap:12px;min-width:0}
.title h1{margin:0;font-size:20px;font-weight:650;letter-spacing:-.01em;overflow-wrap:anywhere}
.kind{color:var(--dim);font-weight:400}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;min-width:0}
.card-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;padding:10px 16px;border-bottom:1px solid var(--border-soft)}
.card-h h2{margin:0 6px 0 0;font-size:13.5px;font-weight:650}
.card-h .search,.card-h .file{margin-left:auto}
.card-h .file{color:var(--dim);overflow-wrap:anywhere}
.card-body{padding:16px}
.card-body>*+*{margin-top:16px}
.card-body.flush{padding:0}
.pairs{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px 28px;margin:0}
.pairs dt{font-size:12px;color:var(--dim);margin-bottom:1px}
.pairs dd{margin:0;overflow-wrap:anywhere}
.flag{font-size:12px;padding:1px 6px;border-radius:4px;background:var(--surface-alt);display:inline-block;margin:0 4px 2px 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:20px 36px}
.stat{display:flex;gap:16px;align-items:center;min-width:0}
.ring{position:relative;width:64px;height:64px;flex:none}
.ring svg{display:block}
.ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:13.5px;font-variant-numeric:tabular-nums}
.stat-label{font-size:12px;color:var(--dim)}
.stat-total{font-size:24px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1;margin-top:3px}
.stat-time{font-size:17px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.25;margin-top:3px}
.legend{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:6px;font-size:12.5px;font-variant-numeric:tabular-nums}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{width:8px;height:8px;border-radius:2px;background:var(--s)}
.legend .zero i{background:var(--border)}
.zero{color:var(--faint)}
.hot{color:var(--failed);font-weight:700}
.pill{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--s);background:color-mix(in srgb,var(--s) 14%,transparent);white-space:nowrap}
.pill.solid{background:var(--s);color:var(--on-status)}
.mark{flex:none;display:inline-grid;place-items:center;width:18px;height:18px;border-radius:50%;color:var(--s);background:color-mix(in srgb,var(--s) 16%,transparent);font-size:10.5px;font-weight:800;line-height:1}
.status-code{font:600 12.5px var(--mono);white-space:nowrap}
.k-ok{color:var(--ok)}.k-redirect{color:var(--redirect)}.k-client{color:var(--client)}.k-server{color:var(--server)}
.method{font:700 11.5px var(--mono);letter-spacing:.02em}
.m-get{color:var(--m-get)}.m-post{color:var(--m-post)}.m-put{color:var(--m-put)}.m-patch{color:var(--m-patch)}.m-delete{color:var(--m-delete)}.m-head{color:var(--m-head)}.m-options{color:var(--m-options)}
.search{font:inherit;font-size:13px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);min-width:0;flex:1 1 180px;max-width:300px}
.chip{font:inherit;font-size:12.5px;display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 4px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;white-space:nowrap}
.chip b{font-variant-numeric:tabular-nums}
.chip[aria-pressed="false"]{opacity:.45}
.btn{font:inherit;font-size:12.5px;padding:4px 12px;border:1px solid var(--border);border-radius:6px;background:var(--surface);color:var(--text);cursor:pointer;white-space:nowrap}
.btn.sm{font-size:11.5px;padding:2px 9px;border-radius:5px}
.btn:hover,.chip:hover{border-color:var(--faint)}
.seg{display:inline-flex;border:1px solid var(--border);border-radius:7px;padding:1px;background:var(--surface-alt)}
.seg button{font:inherit;font-size:11.5px;border:none;background:none;color:var(--dim);padding:2px 9px;border-radius:5px;cursor:pointer}
.seg button[aria-pressed="true"]{background:var(--surface);color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.1)}
.scroll-x{overflow-x:auto}
.overview{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:13px}
.overview th{font-size:11.5px;font-weight:600;color:var(--dim);text-align:left;padding:6px 10px;white-space:nowrap}
.overview thead tr:last-child th{border-bottom:1px solid var(--border)}
.overview .groups th{padding:10px 10px 0;text-transform:uppercase;letter-spacing:.08em;font-size:10.5px;color:var(--faint)}
.overview td{padding:7px 10px;border-bottom:1px solid var(--border-soft);vertical-align:top}
.overview tbody tr:last-child td{border-bottom:none}
.overview .r{text-align:right}
.overview .gs{border-left:1px solid var(--border-soft)}
.overview td.name{min-width:10rem;overflow-wrap:anywhere}
@media (max-width:960px){.overview th,.overview td{padding-left:6px;padding-right:6px}.overview .groups th{padding-left:6px;padding-right:6px}}
.overview td.n{color:var(--faint)}
.overview tbody tr:hover td{background:var(--surface-alt)}
.overview tr.s-failed td:first-child{box-shadow:inset 3px 0 0 var(--failed)}
.group-h{margin:0 0 8px;font-size:13px;font-weight:600}
.group-h .dim{font-weight:400}
.excluded{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 24px}
.excluded li{font:12.5px var(--mono);display:flex;gap:8px;align-items:center;overflow-wrap:anywhere}
.excluded li::before{content:"⊘";color:var(--faint);font-family:var(--sans)}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:10px 12px;margin:28px 0 10px}
.toolbar h2{margin:0 8px 0 0;font-size:17px;font-weight:650}
.tools-end{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.tests{border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden}
.test+.test{border-top:1px solid var(--border)}
.test>summary{display:flex;align-items:center;gap:10px;padding:11px 14px;cursor:pointer;list-style:none}
.test>summary::-webkit-details-marker{display:none}
.test>summary .n{width:1.6em;color:var(--faint);font-variant-numeric:tabular-nums;text-align:right;flex:none}
.test>summary .method{width:52px;flex:none}
.test>summary .name{flex:1;min-width:0;font-weight:500;overflow-wrap:anywhere}
.test>summary .res{display:flex;align-items:center;gap:10px;font-size:12.5px;flex:none;font-variant-numeric:tabular-nums}
.chev{color:var(--faint);font-size:12px;transition:transform .15s}
.test[open]>summary .chev{transform:rotate(90deg)}
.test[open]>summary{background:var(--surface-alt)}
.test.s-failed>summary,.test.s-errored>summary{box-shadow:inset 3px 0 0 var(--s)}
.test-body{padding:16px;display:grid;gap:20px;border-top:1px solid var(--border-soft);min-width:0}
.empty{margin:0;padding:16px}
.skip-reason{margin:0;color:var(--skipped)}
.sub{min-width:0}
.sub h3{margin:0 0 8px;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
.sub h3 .dim{text-transform:none;letter-spacing:0;font-weight:400;margin-left:6px}
.sub-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-bottom:8px}
.sub-h h3{margin:0}
.line{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;min-width:0}
.line .url{overflow-wrap:anywhere;min-width:0}
.line .btn{margin-left:auto;align-self:center}
.mk-inline{font-weight:700}
.none{margin:8px 0 0}
.part{margin-top:10px;border:1px solid var(--border-soft);border-radius:6px;overflow:hidden;background:var(--surface);min-width:0}
.part-h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:5px 6px 5px 10px;background:var(--surface-alt);font-size:12px;font-weight:600;border-bottom:1px solid var(--border-soft)}
.part-h .dim{font-weight:400;overflow-wrap:anywhere}
.end{margin-left:auto;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.pad{margin:0;padding:8px 10px}
.kv{width:100%;border-collapse:collapse;font:12px/1.45 var(--mono)}
.kv td{padding:3px 10px;border-top:1px solid var(--border-soft);vertical-align:top;overflow-wrap:anywhere}
.kv tr:first-child td{border-top:none}
.kv .k{color:var(--dim);white-space:nowrap;width:1%}
.kv .mk{width:1%;padding-right:0;text-align:center}
.raw{max-height:440px;overflow:auto;padding:8px 10px;font:12px/1.55 var(--mono);white-space:pre-wrap;word-break:break-all}
.codeview{font:12px/1.6 var(--mono);max-height:min(70vh,640px);overflow:auto;padding:6px 0}
.codeview:has(.peek-row:not([hidden])){max-height:none}
.ln{display:flex;padding-right:12px}
.ln .no{flex:none;width:3.2em;text-align:right;padding-right:10px;color:var(--faint);user-select:none}
.ln .mk{flex:none;width:1.4em;text-align:center;user-select:none}
.ln .tx{flex:1;min-width:0;white-space:pre-wrap;word-break:break-all}
.ln.cut .tx{color:var(--dim);font-style:italic}
.ln.mk-fail,.kv .mk-fail{background:color-mix(in srgb,var(--failed) 12%,transparent)}
.mk-pass .mk,.mk-inline.mk-pass{color:var(--passed)}
.mk-fail .mk,.mk-inline.mk-fail{color:var(--failed);font-weight:700}
.mk-unasserted .mk,.mk-inline.mk-unasserted{color:var(--errored);font-weight:700}
.mk-ignored .mk{color:var(--faint)}
.ln .note{color:var(--failed);font:600 11.5px var(--sans);margin-left:12px;white-space:normal}
.j-k{color:var(--j-key)}.j-s{color:var(--j-str)}.j-n{color:var(--j-num)}.j-l{color:var(--j-lit)}
.peek{font:600 11px var(--sans);margin-left:10px;padding:1px 9px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--link);cursor:pointer;white-space:nowrap}
.peek[aria-expanded="true"]{background:var(--surface-alt);border-color:var(--faint)}
.peek-row{padding:4px 12px 10px 4.6em}
.peek-panel{border:1px solid var(--border);border-radius:8px;background:var(--surface);overflow:hidden;font:13px/1.5 var(--sans)}
.peek-h{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;padding:5px 6px 5px 10px;background:var(--surface-alt);border-bottom:1px solid var(--border-soft);font-size:12px}
.peek-h code{font-weight:600;overflow-wrap:anywhere}
.html-frame{height:300px;min-height:120px;resize:vertical;overflow:hidden;background:var(--canvas)}
.html-frame iframe{display:block;width:100%;height:100%;border:0}
.frame-note{margin:0;padding:5px 10px;font-size:11.5px;color:var(--dim);border-top:1px solid var(--border-soft)}
.img-view{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px;padding:12px}
.checker{display:inline-block;max-width:100%;padding:10px;border-radius:6px;background-color:var(--check-a);background-image:conic-gradient(var(--check-b) 25%,transparent 0 50%,var(--check-b) 0 75%,transparent 0);background-size:16px 16px}
.checker img{display:block;max-width:100%;height:auto}
.checks{list-style:none;margin:0;padding:0;border:1px solid var(--border-soft);border-radius:6px;background:var(--surface)}
.checks li{display:flex;gap:10px;padding:8px 10px;align-items:flex-start}
.checks li+li{border-top:1px solid var(--border-soft)}
.check{flex:1;min-width:0}
.check-name{font:12.5px var(--mono);overflow-wrap:anywhere}
.check-msg{font-size:13px;margin-top:2px;color:var(--dim)}
.s-failed .check-msg{color:var(--failed)}
.ea{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:6px 0 0;font-size:12.5px}
.ea dt{color:var(--dim)}
.ea dd{margin:0;overflow-wrap:anywhere}
.src{font:11.5px var(--mono);color:var(--faint);flex:none;white-space:nowrap}
.problem pre{color:var(--failed);background:color-mix(in srgb,var(--failed) 7%,var(--surface));border:1px solid color-mix(in srgb,var(--failed) 30%,var(--border));border-radius:6px;padding:8px 10px}
.console{background:var(--surface-alt);border-radius:6px;padding:8px 10px}
.console .log-warn{color:var(--errored)}.console .log-error{color:var(--failed)}
.md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
.md-p{margin:0 0 8px}
.md-h{margin:12px 0 6px;font-size:1rem;font-weight:600}
.md-list{margin:0 0 8px;padding-left:24px}
.md-list .md-list{margin:2px 0 0}
.md-code{margin:0 0 8px;padding:8px 10px;background:var(--surface-alt);border-radius:6px}
.md-inline-code{background:var(--surface-alt);padding:1px 4px;border-radius:3px}
.md-quote{margin:0 0 8px;padding-left:12px;border-left:3px solid var(--border);color:var(--dim)}
.md-hr{border:none;border-top:1px solid var(--border);margin:10px 0}
.md-table{border-collapse:collapse;margin:0 0 8px}
.md-table th,.md-table td{border:1px solid var(--border);padding:4px 8px;text-align:left}
.md-table th{background:var(--surface-alt)}
.foot{margin-top:28px;padding-top:16px;border-top:1px solid var(--border-soft);display:flex;justify-content:center;align-items:center;gap:8px;color:var(--dim);font-size:12.5px}
.foot a{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);color:var(--text);font-weight:600}
.foot a:hover{border-color:var(--faint);text-decoration:none}
.foot a span{color:var(--dim);font-weight:400}
@media (max-width:560px){.test>summary .res .status-code,.test>summary .method{display:none}}
@media (prefers-reduced-motion:reduce){.chev{transition:none}}
`

/**
 * Filters, Expand All, the Formatted / Raw and Rendered / Source switches,
 * View panels, Copy, and filling each HTML frame once it is shown. Raw so its
 * regular expressions keep their backslashes.
 */
const SCRIPT = String.raw`
// What an HTML frame may do beyond showing itself: nothing it could load from.
const SANDBOX = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; font-src data:; form-action \'none\'">'
function filter() {
  const hidden = new Set([...document.querySelectorAll('[data-hide][aria-pressed="false"]')].map((b) => b.dataset.hide))
  const input = document.querySelector('.search')
  const query = input ? input.value.trim().toLowerCase() : ''
  for (const el of document.querySelectorAll('[data-status][data-search]')) {
    el.classList.toggle('hidden', hidden.has(el.dataset.status))
    el.classList.toggle('unmatched', query !== '' && !el.dataset.search.includes(query))
  }
}
// The button says what a click will do: Expand All while any test is closed,
// Collapse All once every one is open — however they got that way.
const tests = () => [...document.querySelectorAll('details.test')]
function syncExpandAll() {
  const button = document.getElementById('expand-all')
  if (button) button.textContent = tests().some((d) => !d.open) ? 'Expand All' : 'Collapse All'
}
// A frame is filled when first shown, from the text it names: a response's raw
// text, whose body follows the first blank line, or a viewer's source.
function loadFrames(scope) {
  for (const frame of scope.querySelectorAll('iframe[data-from]:not([srcdoc])')) {
    if (frame.offsetParent === null) continue
    const text = document.getElementById(frame.dataset.from).textContent
    const html = frame.hasAttribute('data-body') ? text.slice(text.indexOf('\n\n') + 2) : text
    frame.srcdoc = SANDBOX + html.replace(/<meta[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/gi, '')
  }
}
// Every part of a request or response is read from its raw text, as sent or received.
function copied(button) {
  const what = button.dataset.copy
  if (what === 'image') return button.closest('.peek-panel, .part').querySelector('img').getAttribute('src')
  if (what === 'source') return button.closest('.peek-panel').querySelector('[data-part="source"]').textContent
  const raw = button.closest('[data-exchange]').querySelector('[data-raw]').textContent
  const blank = raw.indexOf('\n\n')
  const head = (blank < 0 ? raw : raw.slice(0, blank)).split('\n')
  if (what === 'raw') return raw
  if (what === 'body') return blank < 0 ? '' : raw.slice(blank + 2)
  if (what === 'headers') return head.slice(1).join('\n')
  return head[0].replace(/^\S+ /, '')
}
function copy(text, button) {
  button.dataset.label ??= button.textContent
  const done = (label) => {
    button.textContent = label
    setTimeout(() => { button.textContent = button.dataset.label }, 1500)
  }
  const byHand = () => {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    done(ok ? 'Copied' : 'Copy failed')
  }
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done('Copied'), byHand)
  else byHand()
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) return
  if (button.dataset.hide) {
    button.setAttribute('aria-pressed', String(button.getAttribute('aria-pressed') === 'false'))
    filter()
  } else if (button.id === 'expand-all') {
    const open = tests().some((d) => !d.open)
    for (const d of tests()) d.open = open
    syncExpandAll()
  } else if (button.dataset.show) {
    const box = button.closest('[data-switch]')
    for (const b of box.querySelectorAll('[data-show]')) {
      if (b.closest('[data-switch]') === box) b.setAttribute('aria-pressed', String(b === button))
    }
    for (const part of box.querySelectorAll(':scope > [data-part]')) part.hidden = part.dataset.part !== button.dataset.show
    loadFrames(box)
  } else if (button.dataset.peek) {
    const open = button.getAttribute('aria-expanded') !== 'true'
    button.setAttribute('aria-expanded', String(open))
    const panel = document.getElementById(button.dataset.peek)
    panel.hidden = !open
    if (open) loadFrames(panel)
  } else if (button.dataset.close) {
    document.getElementById(button.dataset.close).hidden = true
    document.querySelector('[data-peek="' + button.dataset.close + '"]')?.setAttribute('aria-expanded', 'false')
  } else if (button.dataset.copy) {
    copy(copied(button), button)
  }
})
document.addEventListener('input', (event) => {
  if (event.target.matches('.search')) filter()
})
document.addEventListener('toggle', (event) => {
  if (!event.target.matches('details.test')) return
  syncExpandAll()
  if (event.target.open) loadFrames(event.target)
}, true)
// An image's size, once it has loaded.
document.addEventListener('load', (event) => {
  const dims = event.target.tagName === 'IMG' && event.target.closest('.peek-panel, .part')?.querySelector('[data-dims]')
  if (dims) dims.textContent = event.target.naturalWidth + ' × ' + event.target.naturalHeight + ' · '
}, true)
document.addEventListener('DOMContentLoaded', () => {
  syncExpandAll()
  loadFrames(document)
})
`
