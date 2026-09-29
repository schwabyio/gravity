import { useEffect, useMemo, useRef, useState } from 'react'
import { formatPath, type RunResult } from '@schwabyio/gravity-core/model'
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

export type ResponseTab = 'body' | 'headers' | 'timings'

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
}

const statusClass = (status: number): string => {
  if (status < 200) return 'info'
  if (status < 300) return 'ok'
  if (status < 400) return 'redirect'
  if (status < 500) return 'client'
  return 'server'
}

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`

const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`

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

  if (running) return <div className="placeholder">Sending…</div>
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
      </div>

      <div className={`tab-body${tab === 'body' ? ' body-tab' : ''}`}>
        {tab === 'body' && <BodyTab {...props} result={result} />}

        {tab === 'headers' && <HeadersTab {...props} result={result} />}

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
 * server sent — XML converted, arrays sorted — a switch offers the raw text too.
 */
function BodyTab(props: Props & { result: RunResult }) {
  const { result, checks, focus, selected, jumpedPath } = props
  const response = result.response!
  const [raw, setRaw] = useState(false)
  const listRef = useRef<HTMLOListElement>(null)

  const differs = checkedDiffersFromRaw(response, result.sortedBy)
  const body = useMemo(() => checkedBody(response, result.sortedBy), [response, result.sortedBy])
  const marks = useMemo(() => (body.ok ? markLines(body.lines, checks) : []), [body, checks])
  const showRaw = differs && raw

  const jumpedLine = useMemo(
    () =>
      jumpedPath !== null && body.ok
        ? body.lines.findIndex((line) => formatPath(line.path) === jumpedPath)
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
