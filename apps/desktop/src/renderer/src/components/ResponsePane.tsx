import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parsePath,
  pathMatches,
  type EventStreamRead,
  type RunResult,
  type StreamEvent
} from '@schwabyio/gravity-core/model'
import {
  MARK_GLYPH,
  checkedBody,
  checkedDiffersFromRaw,
  markHeaders,
  markLines,
  markStatus,
  type Check,
  type Marked
} from '../testLinks.js'
import { formatMs, formatSize } from '../format.js'

export type ResponseTab = 'body' | 'headers' | 'timings' | 'request'

interface Props {
  result: RunResult | null
  error: string | null
  running: boolean

  tab: ResponseTab
  onTab: (tab: ResponseTab) => void

  /** The step's assertions, for marking the lines and headers they are about. */
  checks: Check[]
  /** The assertion being pointed at: hovered, else selected. */
  focus: number | null
  /** The selected assertion, which the body scrolls to. */
  selected: number | null
  /** A single body path to point at, from strict validation's leftovers. */
  jumpedPath: string | null
  /** A marked line or row was clicked: these are the assertions about it. */
  onPick: (about: number[]) => void

  /** While running: the event stream being read, as it is read. */
  live?: LiveView | null
  /** Stop reading it: a normal end, so its checks run on what came. */
  onStop?: () => void
}

/** An event stream as it is read: its status, and each event so far. */
export interface LiveView {
  status: number
  statusText: string
  events: Array<{ event: StreamEvent; at: number }>
  /** How many arrived, when `events` keeps only the latest. */
  count: number
}

/** The colour a status shows in: `ok` for 2xx, `client` for 4xx, and so on. */
export const statusClass = (status: number): string => {
  if (status < 200) return 'info'
  if (status < 300) return 'ok'
  if (status < 400) return 'redirect'
  if (status < 500) return 'client'
  return 'server'
}

/** What stopped an event stream's reading, as the summary says it. */
const ENDED_BY: Record<EventStreamRead['endedBy'], { short: string; long: string }> = {
  close: { short: 'closed by the server', long: 'The server closed the stream.' },
  maxEvents: { short: 'max events reached', long: 'Reading stopped at the Max events setting.' },
  streamTimeout: {
    short: 'stream timeout reached',
    long: 'Reading stopped at the Stream timeout setting.'
  },
  untilEvent: {
    short: 'until event reached',
    long: 'Reading stopped at the event the Until event setting names.'
  },
  limit: {
    short: 'safety limit reached',
    long: 'Reading stopped at the safety limit: 1,000 events or 10 MB.'
  },
  stopped: { short: 'stopped', long: 'Reading was stopped with the Stop button.' },
  held: {
    short: 'took what had arrived',
    long: 'On a connection, a step that sets none of Max events, Stream timeout or Until event waits for nothing: it takes the events already held.'
  }
}

/** The connection a step opened or read, and whether it is still open. */
const connectionNote = (stream: EventStreamRead): string | null =>
  stream.connection
    ? `connection ${stream.connection.name} ${stream.connection.open ? 'open' : 'closed'}`
    : null

/** Pretty-print JSON so a response is readable without leaving the panel. */
function presentBody(body: string, kind: string): string {
  if (kind !== 'json') return body
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

const markClass = (marked: Marked | undefined, focused: boolean): string =>
  [
    marked?.mark ? `mark-${marked.mark}` : '',
    marked && marked.about.length > 0 ? 'linked' : '',
    focused ? 'focused' : ''
  ].join(' ')

export default function ResponsePane(props: Props) {
  const { result, error, running, tab, onTab, checks, focus } = props

  if (running) {
    return props.live ? (
      <LiveStreamView live={props.live} onStop={props.onStop} />
    ) : (
      <div className="placeholder">Sending…</div>
    )
  }
  if (error) return <div className="placeholder error">{error}</div>
  if (!result) return <div className="placeholder">Send a request to see the response.</div>

  if (result.skipped) {
    return (
      <div className="placeholder skipped">
        <strong>Skipped</strong>
        <div className="hint">{result.skipped.reason} — nothing was sent.</div>
      </div>
    )
  }

  if (!result.response) {
    const error = result.error
    return (
      <div className="placeholder error">
        {error?.phase === 'pre-request' && (
          <div className="hint">
            {error.script === 'collection'
              ? "The collection's pre-request script"
              : 'Pre-request script'}{' '}
            stopped{error.line !== undefined && ` at line ${error.line}`}, so nothing was sent.
          </div>
        )}
        <strong>{error?.message ?? 'Request failed'}</strong>
        {error?.code && error.phase !== 'pre-request' && <div className="hint">{error.code}</div>}
        {result.logs && result.logs.length > 0 && (
          <ol className="console-lines">
            {result.logs.map((entry, i) => (
              <li key={i} className={`log-${entry.level}`}>
                <span className="log-message">{entry.message}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    )
  }

  const { response } = result
  const status = markStatus(checks)
  const statusFocused = focus !== null && status.about.includes(focus)

  return (
    <div className="response">
      <div className="response-summary">
        <button
          type="button"
          className={`status-pill ${statusClass(response.status)} ${markClass(status, statusFocused)}`}
          onClick={() => props.onPick(status.about)}
          disabled={status.about.length === 0}
          aria-label={`Status ${response.status}${status.mark ? `, ${status.mark === 'pass' ? 'passed' : 'failed'}` : ''}`}
        >
          {status.mark && <span className="pill-mark">{MARK_GLYPH[status.mark]}</span>}
          {response.status} {response.statusText}
        </button>
        <span className="metric">{formatMs(response.timings.totalMs)}</span>
        <span className="metric">{formatSize(response.sizeBytes)}</span>
        <span className="metric" title="Time to first byte">
          TTFB {formatMs(response.timings.ttfbMs)}
        </span>
        {response.redirectCount > 0 && (
          <span className="metric" title={response.url}>
            {response.redirectCount} redirect{response.redirectCount > 1 ? 's' : ''}
          </span>
        )}
        {response.stream && (
          <span className="metric stream-metric" title={ENDED_BY[response.stream.endedBy].long}>
            {response.stream.at.length} event{response.stream.at.length === 1 ? '' : 's'} ·{' '}
            {ENDED_BY[response.stream.endedBy].short}
            {connectionNote(response.stream) && ` · ${connectionNote(response.stream)}`}
          </span>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'body' ? 'active' : ''} onClick={() => onTab('body')}>
          Body
        </button>
        <button className={tab === 'headers' ? 'active' : ''} onClick={() => onTab('headers')}>
          Headers <span className="count">{response.headers.length}</span>
        </button>
        <button className={tab === 'timings' ? 'active' : ''} onClick={() => onTab('timings')}>
          Timings
        </button>
        <button className={tab === 'request' ? 'active' : ''} onClick={() => onTab('request')}>
          Request
        </button>
      </div>

      <div className={`tab-body${tab === 'body' ? ' body-tab' : ''}`}>
        {tab === 'body' && <BodyTab {...props} result={result} />}

        {tab === 'headers' && <HeadersTab {...props} result={result} />}

        {tab === 'request' && <RequestTab result={result} />}

        {tab === 'timings' && (
          <table className="kv readonly">
            <tbody>
              <tr>
                <td className="header-name">Started</td>
                <td>{new Date(response.timings.startedAt).toLocaleTimeString()}</td>
              </tr>
              <tr>
                <td className="header-name">Time to first byte</td>
                <td>{formatMs(response.timings.ttfbMs)}</td>
              </tr>
              {response.stream && response.stream.at.length > 0 && (
                <tr>
                  <td className="header-name">First event</td>
                  <td>{formatMs(response.stream.at[0]!)} after the headers</td>
                </tr>
              )}
              <tr>
                <td className="header-name">Total</td>
                <td>{formatMs(response.timings.totalMs)}</td>
              </tr>
              <tr>
                <td className="header-name">Final URL</td>
                <td className="wrap">{response.url}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

/**
 * The body, line by line, marked by the assertions about each line.
 *
 * Shown as the engine checked it by default. When that differs from what the
 * server sent — XML converted, an event stream read as events, arrays sorted —
 * a switch offers the raw text too.
 */
function BodyTab(props: Props & { result: RunResult }) {
  const { result, checks, focus, selected, jumpedPath } = props
  const response = result.response!
  const [raw, setRaw] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)

  const differs = checkedDiffersFromRaw(response, result.sortedBy)
  const body = useMemo(() => checkedBody(response, result.sortedBy), [response, result.sortedBy])
  const ignored = useMemo(
    () => (result.ignored ?? []).map((entry) => parsePath(entry.path)),
    [result.ignored]
  )
  const marks = useMemo(
    () => (body.ok ? markLines(body.lines, checks, ignored) : []),
    [body, checks, ignored]
  )
  const showRaw = differs && raw

  const jumpedLine = useMemo(
    () =>
      jumpedPath !== null && body.ok
        ? // The first line of it: an ignored `account[].id.value` names no line of its own.
          body.lines.findIndex((line) =>
            pathMatches(parsePath(jumpedPath), line.path, { prefix: true })
          )
        : -1,
    [jumpedPath, body]
  )

  // Bring the selected assertion's first line, or the jumped-to line, into view.
  useEffect(() => {
    const line =
      jumpedLine >= 0
        ? jumpedLine
        : selected !== null
          ? marks.findIndex((m) => m.about.includes(selected))
          : -1
    if (line < 0) return
    listRef.current
      ?.querySelector<HTMLElement>(`[data-line="${line}"]`)
      ?.scrollIntoView({ block: jumpedLine >= 0 ? 'center' : 'nearest' })
  }, [selected, jumpedLine, marks, showRaw])

  if (response.bodyKind === 'empty') return <div className="placeholder">No response body.</div>

  return (
    <div className="body-view">
      {differs && (
        <div className="body-mode" role="group" aria-label="Body view">
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>
            As checked
          </button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>
            Raw
          </button>
          <span className="body-mode-note">
            {showRaw
              ? 'as the server sent it'
              : [
                  response.bodyKind === 'xml' ? 'converted from XML' : null,
                  response.bodyKind === 'events' ? 'read as events' : null,
                  result.sortedBy ? `sorted by ${result.sortedBy.join(', ')}` : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </span>
        </div>
      )}

      {showRaw || !body.ok ? (
        <>
          {!body.ok && <p className="hint body-problem">{body.message}</p>}
          <pre className="code response-body">{presentBody(response.body, response.bodyKind)}</pre>
        </>
      ) : (
        <ol className="body-lines response-body" ref={listRef}>
          {body.lines.map((line, i) => {
            const marked = marks[i]!
            const focused =
              jumpedLine >= 0 ? jumpedLine === i : focus !== null && marked.about.includes(focus)
            return (
              <li
                key={i}
                data-line={i}
                className={markClass(marked, focused)}
                onClick={() => props.onPick(marked.about)}
              >
                <span className="line-no">{i + 1}</span>
                <span className="line-mark" aria-hidden="true">
                  {marked.mark ? MARK_GLYPH[marked.mark] : ''}
                </span>
                <span className="line-text">{line.text}</span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/**
 * An event stream while it is read: its status, the events so far, newest
 * last, and a Stop that ends the reading so the checks run on what came.
 */
function LiveStreamView({ live, onStop }: { live: LiveView; onStop?: (() => void) | undefined }) {
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [live.count])
  return (
    <div className="response live-stream" aria-label="Event stream">
      <div className="response-summary">
        <span className={`status-pill ${statusClass(live.status)}`}>
          {live.status} {live.statusText}
        </span>
        <span className="metric stream-metric" aria-live="polite">
          {live.count} event{live.count === 1 ? '' : 's'} · reading…
        </span>
        {onStop && (
          <button type="button" className="stop" onClick={onStop}>
            Stop
          </button>
        )}
      </div>
      {live.events.length === 0 ? (
        <div className="placeholder">Waiting for events…</div>
      ) : (
        <ol className="live-events" ref={listRef}>
          {live.events.map(({ event, at }, i) => (
            <li key={live.count - live.events.length + i}>
              <span className="line-no">+{formatMs(at)}</span>
              <span className="line-text">{JSON.stringify(event)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}

/**
 * The request as it was sent: every header, whichever layer it came from or
 * whether a script added it, with variables resolved and secrets hidden.
 */
function RequestTab({ result }: { result: RunResult }) {
  const { request } = result
  return (
    <section className="sent-request" aria-label="Request as sent">
      <p className="sent-line">
        <strong>{request.method}</strong> <span>{request.url}</span>
      </p>
      <h4>Headers</h4>
      {request.headers.length > 0 ? (
        <table className="kv readonly" aria-label="Headers sent">
          <tbody>
            {request.headers.map((header, i) => (
              <tr key={`${header.name}-${i}`}>
                <td className="header-name">{header.name}</td>
                <td className="wrap">{header.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="hint">None.</p>
      )}
      <h4>Body</h4>
      {request.body !== null && request.body !== '' ? (
        <pre className="sent-body" aria-label="Body sent">
          {request.body}
        </pre>
      ) : (
        <p className="hint">None.</p>
      )}
    </section>
  )
}

function HeadersTab(props: Props & { result: RunResult }) {
  const { result, checks, focus } = props
  const headers = result.response!.headers
  const marks = useMemo(() => markHeaders(headers, checks), [headers, checks])
  const anyMarked = marks.some((m) => m.mark !== null)

  return (
    <table className="kv readonly response-headers">
      <tbody>
        {headers.map((header, i) => {
          const marked = marks[i]!
          const focused = focus !== null && marked.about.includes(focus)
          return (
            <tr
              key={`${header.name}-${i}`}
              className={markClass(marked, focused)}
              onClick={() => props.onPick(marked.about)}
            >
              {anyMarked && (
                <td className="row-mark" aria-hidden="true">
                  {marked.mark ? MARK_GLYPH[marked.mark] : ''}
                </td>
              )}
              <td className="header-name">{header.name}</td>
              <td>{header.value}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
