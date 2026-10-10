import {
  resultName,
  type CollectionRunSummary,
  type HeaderEntry,
  type LogEntry,
  type ReceivedResponse,
  type RunError,
  type RunResult,
  type SentRequest
} from '@schwabyio/gravity-core/model'
import type { ConsoleEvent, ConsoleRunKind, IterationRef, LoadEvent } from '@shared/ipc.js'
import { formatMs, formatSize } from './format.js'
import { matches } from './sidebarFilter.js'

/**
 * The console: every run's requests, script output and errors, whichever
 * collection it was of, and the load log — what listing projects took — kept
 * until Clear or quit. Pure, so the panel and its tests agree on what it holds
 * and what it shows.
 */

/** The most results kept: past it, the oldest go, with what their scripts wrote. */
export const MAX_RESULTS = 1000
/** The most lines drawn at once: past it, the latest. A filter finds older ones. */
export const MAX_ROWS = 2000

/** A collection run's totals, without its results. */
export type RunTotals = Omit<CollectionRunSummary, 'results'>

/** What the console knows of the run a result came from. */
export interface ConsoleRun {
  kind: ConsoleRunKind
  collection: string | null
  environment: string | null
  rows?: number
}

export interface ResultEntry {
  kind: 'result'
  /** Unique for the session: React's key, and which requests are open. */
  key: number
  /** Epoch milliseconds the result landed. */
  at: number
  /** Null for a result of a run the console did not see start. */
  run: ConsoleRun | null
  result: RunResult
  iteration?: IterationRef
}

export type ConsoleEntry =
  | { kind: 'start'; key: number; at: number; run: ConsoleRun }
  | ResultEntry
  | {
      kind: 'end'
      key: number
      at: number
      run: ConsoleRun | null
      totals?: RunTotals
      failure?: string
    }
  /** A line of the load log. */
  | { kind: 'load'; key: number; event: LoadEvent }

export interface ConsoleState {
  entries: ConsoleEntry[]
  /** Runs started and not yet ended, by id, for their results to name. */
  runs: Record<string, ConsoleRun>
  next: number
  /** Results gone to keep the latest `MAX_RESULTS`, since the last Clear. */
  dropped: number
}

export const EMPTY_CONSOLE: ConsoleState = { entries: [], runs: {}, next: 0, dropped: 0 }

export type ConsoleAction = { type: 'event'; event: ConsoleEvent } | { type: 'clear' }

export function consoleReducer(state: ConsoleState, action: ConsoleAction): ConsoleState {
  // Runs in flight still name the results they bring back after a Clear.
  if (action.type === 'clear') return { ...EMPTY_CONSOLE, runs: state.runs, next: state.next }
  const { event } = action
  const key = state.next
  const next = key + 1
  switch (event.kind) {
    case 'start': {
      const run: ConsoleRun = {
        kind: event.run,
        collection: event.collection,
        environment: event.environment,
        ...(event.rows ? { rows: event.rows } : {})
      }
      return {
        ...state,
        next,
        runs: { ...state.runs, [event.runId]: run },
        entries: [...state.entries, { kind: 'start', key, at: event.at, run }]
      }
    }
    case 'result':
      return trimmed({
        ...state,
        next,
        entries: [
          ...state.entries,
          {
            kind: 'result',
            key,
            at: event.at,
            run: state.runs[event.runId] ?? null,
            result: event.result,
            ...(event.iteration ? { iteration: event.iteration } : {})
          }
        ]
      })
    case 'load':
      return { ...state, next, entries: [...state.entries, { kind: 'load', key, event }] }
    case 'end': {
      const { [event.runId]: run = null, ...runs } = state.runs
      return {
        ...state,
        next,
        runs,
        entries: [
          ...state.entries,
          {
            kind: 'end',
            key,
            at: event.at,
            run,
            ...(event.totals ? { totals: event.totals } : {}),
            ...(event.failure !== undefined ? { failure: event.failure } : {})
          }
        ]
      }
    }
  }
}

/** At most `MAX_RESULTS` results: the oldest go, with anything before them. */
function trimmed(state: ConsoleState): ConsoleState {
  const extra = state.entries.filter((entry) => entry.kind === 'result').length - MAX_RESULTS
  if (extra <= 0) return state
  let left = extra
  let cut = 0
  while (left > 0) {
    if (state.entries[cut]!.kind === 'result') left--
    cut++
  }
  return { ...state, entries: state.entries.slice(cut), dropped: state.dropped + extra }
}

/* ------------------------------------------------------------------ rows -- */

/** One line of the console, as drawn. */
export type ConsoleRow =
  /** Run all began. */
  | { kind: 'start'; key: string; at: number; text: string }
  /** A run ended: Run all's totals, or why a run could not run. */
  | { kind: 'end'; key: string; at: number; text: string; problem: boolean }
  /** A request, sent or not: one result. */
  | { kind: 'request'; key: string; entry: ResultEntry; source: string }
  /** A step not run, and why. */
  | { kind: 'skipped'; key: string; at: number; source: string; reason: string }
  /** A line a step's script wrote. */
  | { kind: 'log'; key: string; log: LogEntry; source: string }
  /** What stopped a step. */
  | { kind: 'error'; key: string; error: RunError; source: string }
  /** A line of the load log, about a project, git, the app or a file. */
  | { kind: 'load'; key: string; at: number; subject: string; text: string; problem: boolean }

const RUN_NAME: Record<ConsoleRunKind, string> = { send: 'Send', steps: 'Run', all: 'Run all' }

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/** Which step a result is of, and where: `users › get user · iteration 2 (ada)`. */
export function sourceOf(entry: ResultEntry): string {
  const name = resultName(entry.result)
  const where = entry.run?.collection ? `${entry.run.collection} › ${name}` : name
  const iteration = entry.iteration
  return iteration
    ? `${where} · iteration ${iteration.index}${iteration.label ? ` (${iteration.label})` : ''}`
    : where
}

const startText = (run: ConsoleRun): string =>
  [
    RUN_NAME[run.kind],
    run.collection,
    run.environment ?? 'no environment',
    run.rows ? plural(run.rows, 'data row') : null
  ]
    .filter(Boolean)
    .join(' · ')

const totalsText = (totals: RunTotals): string =>
  [
    `Run all finished in ${formatMs(totals.durationMs)}`,
    `${totals.passed} passed`,
    totals.failed > 0 ? `${totals.failed} failed` : null,
    totals.errored > 0 ? `${totals.errored} errored` : null,
    totals.skipped > 0 ? `${totals.skipped} skipped` : null
  ]
    .filter(Boolean)
    .join(' · ')

/**
 * An entry's lines. A result is its request, then what its scripts wrote —
 * each line saying which script — then what stopped it. Only Run all has lines
 * of its own for its start and totals: a Send's request says what it was.
 */
function linesOf(entry: ConsoleEntry): ConsoleRow[] {
  const key = String(entry.key)
  if (entry.kind === 'load') {
    const { at, subject, text, problem = false } = entry.event
    return [{ kind: 'load', key, at, subject, text, problem }]
  }
  if (entry.kind === 'start') {
    return entry.run.kind === 'all'
      ? [{ kind: 'start', key, at: entry.at, text: startText(entry.run) }]
      : []
  }
  if (entry.kind === 'end') {
    if (entry.failure !== undefined) {
      const name = RUN_NAME[entry.run?.kind ?? 'send']
      const text = `${name} could not run: ${entry.failure}`
      return [{ kind: 'end', key, at: entry.at, text, problem: true }]
    }
    if (entry.run?.kind !== 'all' || !entry.totals) return []
    const problem = entry.totals.failed + entry.totals.errored > 0
    return [{ kind: 'end', key, at: entry.at, text: totalsText(entry.totals), problem }]
  }
  const { result } = entry
  const source = sourceOf(entry)
  const head: ConsoleRow =
    result.status === 'skipped'
      ? {
          kind: 'skipped',
          key,
          at: entry.at,
          source,
          reason: result.skipped?.reason ?? 'not run'
        }
      : { kind: 'request', key, entry, source }
  return [
    head,
    ...(result.logs ?? []).map((log, i): ConsoleRow => ({
      kind: 'log',
      key: `${key}.log${i}`,
      log,
      source
    })),
    ...(result.error
      ? [{ kind: 'error' as const, key: `${key}.error`, error: result.error, source }]
      : [])
  ]
}

/** Entries never change, so their lines are worked out once. */
const linesCache = new WeakMap<ConsoleEntry, ConsoleRow[]>()

export function rowsOf(entry: ConsoleEntry): ConsoleRow[] {
  let rows = linesCache.get(entry)
  if (!rows) {
    rows = linesOf(entry)
    linesCache.set(entry, rows)
  }
  return rows
}

/** Which lines the console shows. */
export type ConsoleShow = 'all' | 'requests' | 'logs' | 'loading' | 'problems'

export const SHOW_LABELS: Record<ConsoleShow, string> = {
  all: 'Everything',
  requests: 'Requests',
  logs: 'Script output',
  loading: 'Loading projects',
  problems: 'Failures, warnings and errors'
}

/** A failed or errored request, a warning or error a script wrote, an error, a run that failed. */
export function isProblem(row: ConsoleRow): boolean {
  switch (row.kind) {
    case 'request':
      return row.entry.result.status === 'fail' || row.entry.result.status === 'error'
    case 'log':
      return row.log.level === 'warn' || row.log.level === 'error'
    case 'error':
      return true
    case 'end':
    case 'load':
      return row.problem
    default:
      return false
  }
}

const SHOWN: Record<ConsoleShow, (row: ConsoleRow) => boolean> = {
  all: () => true,
  requests: (row) => row.kind === 'request' || row.kind === 'skipped',
  logs: (row) => row.kind === 'log',
  loading: (row) => row.kind === 'load',
  problems: isProblem
}

/** What a filter's words are looked for in. */
function wordsOf(row: ConsoleRow): string[] {
  switch (row.kind) {
    case 'start':
    case 'end':
      return [row.text]
    case 'request': {
      const { request, response } = row.entry.result
      return [request.method, request.url, response ? String(response.status) : '', row.source]
    }
    case 'skipped':
      return ['skipped', row.reason, row.source]
    case 'log':
      return [row.log.message, row.source]
    case 'error':
      return [row.error.message, row.source]
    case 'load':
      return [row.subject, row.text]
  }
}

/**
 * The lines to draw: those `show` picks with every word of `query` in them, in
 * any case — the latest `MAX_ROWS` of them, and how many earlier ones that leaves out.
 */
export function shownRows(
  entries: ConsoleEntry[],
  show: ConsoleShow,
  query: string
): { rows: ConsoleRow[]; hidden: number } {
  const rows = entries
    .flatMap(rowsOf)
    .filter((row) => SHOWN[show](row) && matches(query, ...wordsOf(row)))
  return rows.length > MAX_ROWS
    ? { rows: rows.slice(-MAX_ROWS), hidden: rows.length - MAX_ROWS }
    : { rows, hidden: 0 }
}

/** Errors — steps that errored, runs that could not run, `console.error` — and `console.warn`s. */
export function problemCounts(entries: ConsoleEntry[]): { errors: number; warnings: number } {
  let errors = 0
  let warnings = 0
  for (const entry of entries) {
    if (entry.kind === 'end' && entry.failure !== undefined) errors++
    // A folder that could not be read: what the project shows may be short.
    if (entry.kind === 'load' && entry.event.problem) warnings++
    if (entry.kind !== 'result') continue
    if (entry.result.status === 'error') errors++
    for (const log of entry.result.logs ?? []) {
      if (log.level === 'error') errors++
      else if (log.level === 'warn') warnings++
    }
  }
  return { errors, warnings }
}

/**
 * The lines as text, one to a line, as the console shows them: what Copy puts
 * on the clipboard, for a report of what happened.
 */
export function rowsText(rows: ConsoleRow[]): string {
  return rows.map(rowText).join('\n')
}

/** Lines with no time of their own line up under those with one. */
const NO_TIME = ' '.repeat('00:00:00.000'.length)

function rowText(row: ConsoleRow): string {
  switch (row.kind) {
    case 'start':
    case 'end':
      return `${clockTime(row.at)}  ${row.text}`
    case 'request': {
      const { result } = row.entry
      const ms = result.response?.timings.totalMs ?? result.durationMs
      return [
        clockTime(sentAt(row.entry)),
        `${result.request.method} ${result.request.url}`,
        outcomeOf(result),
        formatMs(ms),
        row.source
      ].join('  ')
    }
    case 'skipped':
      return `${clockTime(row.at)}  skipped  ${row.reason}  ${row.source}`
    case 'log':
      return `${NO_TIME}  ${row.log.phase}  ${row.log.message}  ${row.source}`
    case 'error':
      return `${NO_TIME}  ${row.error.phase} error  ${row.error.message}  ${row.source}`
    case 'load':
      return `${clockTime(row.at)}  ${row.problem ? 'PROBLEM ' : ''}${row.subject} · ${row.text}`
  }
}

/* ------------------------------------------------------------------- raw -- */

const headerLine = (header: HeaderEntry) => `${header.name}: ${header.value}`

/**
 * A request as text, as sent: its method and URL, its headers, a blank line
 * and its body — what the step set, with its secrets hidden; undici adds the
 * likes of `host` and `content-length` on its own.
 */
export function rawRequest(request: SentRequest): string {
  const head = [`${request.method} ${request.url}`, ...request.headers.map(headerLine)].join('\n')
  return request.body ? `${head}\n\n${request.body}` : head
}

/** A response as text, as received: its status, its headers, a blank line and its body. */
export function rawResponse(response: ReceivedResponse): string {
  const head = [
    `${response.status} ${response.statusText}`.trim(),
    ...response.headers.map(headerLine)
  ].join('\n')
  // Bytes kept as base64 are not text to show: say what there was instead.
  const body =
    response.bodyEncoding === 'base64'
      ? `[binary body, ${formatSize(response.sizeBytes)}]`
      : response.body
  return body ? `${head}\n\n${body}` : head
}

/** The request, then the response, a blank line between. */
export const rawExchange = (result: RunResult): string =>
  result.response
    ? `${rawRequest(result.request)}\n\n${rawResponse(result.response)}`
    : rawRequest(result.request)

/** What a request came to, for its line: its status, or why there is none. */
export function outcomeOf(result: RunResult): string {
  if (result.response) return `${result.response.status} ${result.response.statusText}`.trim()
  if (result.error?.phase === 'http') return result.error.code ?? 'failed'
  return 'not sent'
}

/** When a request was sent, or for one never sent, when its step began. */
export const sentAt = (entry: ResultEntry): number =>
  entry.result.response?.timings.startedAt ?? entry.at - entry.result.durationMs

const two = (value: number) => String(value).padStart(2, '0')

/** A time of day to the millisecond: `14:03:22.120`. */
export function clockTime(at: number): string {
  const date = new Date(at)
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(
    date.getMilliseconds()
  ).padStart(3, '0')}`
}
