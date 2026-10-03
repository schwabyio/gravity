import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  clockTime,
  MAX_RESULTS,
  MAX_ROWS,
  outcomeOf,
  rawExchange,
  rawRequest,
  rawResponse,
  sentAt,
  SHOW_LABELS,
  shownRows,
  type ConsoleRow,
  type ConsoleShow,
  type ConsoleState,
  type ResultEntry
} from '../consoleLog.js'
import { formatMs, formatSize } from '../format.js'
import type { PaneWidth } from '../hooks/usePaneWidth.js'
import CopyButton from './CopyButton.js'
import { statusClass } from './ResponsePane.js'
import Resizer from './Resizer.js'

/** How much of a raw request or response the console draws: copying takes all of it. */
const DRAWN_TEXT = 64 * 1024

/** How near the bottom counts as at it, for following new lines. */
const NEAR_BOTTOM = 24

interface Props {
  log: ConsoleState & { clear: () => void }
  /** Its height, which its top edge drags. */
  pane: PaneWidth
  onClose: () => void
}

/**
 * The console: every Send's and Run all's requests, what their scripts wrote,
 * and what went wrong, newest at the bottom. A request opens to show itself
 * and its response as raw text, each with a Copy.
 */
export default function ConsolePanel({ log, pane, onClose }: Props) {
  const [show, setShow] = useState<ConsoleShow>('all')
  const [query, setQuery] = useState('')
  /** The requests opened to show their raw text, by row key. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const { rows, hidden } = useMemo(
    () => shownRows(log.entries, show, query),
    [log.entries, show, query]
  )
  const filtering = show !== 'all' || query.trim() !== ''

  // New lines scroll into view, unless the person has scrolled up to read.
  const list = useRef<HTMLOListElement>(null)
  const following = useRef(true)
  const onScroll = () => {
    const element = list.current
    if (element) {
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM
    }
  }
  useLayoutEffect(() => {
    const element = list.current
    if (element && following.current) element.scrollTop = element.scrollHeight
  }, [rows])

  const toggle = (key: string) =>
    setOpened((current) => {
      const next = new Set(current)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const clear = () => {
    log.clear()
    setOpened(new Set())
    following.current = true
  }

  return (
    <section
      className="console-panel"
      aria-label="Console"
      // A height chosen in a taller window, kept, but not past what this one allows.
      style={{ height: Math.min(pane.width, pane.max) }}
    >
      <Resizer pane={pane} label="Resize the console" edge="top" />
      <div className="console-head">
        <h2>Console</h2>
        <input
          type="search"
          className="console-filter"
          placeholder="Filter"
          aria-label="Filter the console"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setQuery('')
          }}
        />
        <select
          aria-label="Show"
          value={show}
          onChange={(event) => setShow(event.target.value as ConsoleShow)}
        >
          {(Object.keys(SHOW_LABELS) as ConsoleShow[]).map((value) => (
            <option key={value} value={value}>
              {SHOW_LABELS[value]}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button type="button" onClick={clear} disabled={log.entries.length === 0}>
          Clear
        </button>
        <button
          type="button"
          className="console-close"
          aria-label="Close the console"
          onClick={onClose}
        >
          ×
        </button>
      </div>
      <ol className="console-rows" ref={list} onScroll={onScroll}>
        {log.dropped > 0 && (
          <li className="console-note">
            Older requests were dropped: the console keeps the latest{' '}
            {MAX_RESULTS.toLocaleString('en-US')}.
          </li>
        )}
        {hidden > 0 && (
          <li className="console-note">
            Showing the latest {MAX_ROWS.toLocaleString('en-US')} lines: filter to find the{' '}
            {hidden.toLocaleString('en-US')} before them.
          </li>
        )}
        {rows.map((row) => (
          <Row
            key={row.key}
            row={row}
            open={opened.has(row.key)}
            onToggle={() => toggle(row.key)}
          />
        ))}
        {rows.length === 0 && (
          <li className="console-note">
            {filtering
              ? 'Nothing here matches the filter.'
              : 'Every request a Send or Run all makes shows here, with what its scripts write and anything that goes wrong.'}
          </li>
        )}
      </ol>
    </section>
  )
}

function Row({ row, open, onToggle }: { row: ConsoleRow; open: boolean; onToggle: () => void }) {
  switch (row.kind) {
    case 'start':
    case 'end':
      return (
        <li className={`console-row run${row.kind === 'end' && row.problem ? ' run-failed' : ''}`}>
          <div className="console-line">
            <time className="console-time">{clockTime(row.at)}</time>
            <span className="console-tag">{row.kind === 'start' ? 'run' : 'done'}</span>
            <span className="console-text">{row.text}</span>
          </div>
        </li>
      )
    case 'skipped':
      return (
        <li className="console-row skipped">
          <div className="console-line">
            <time className="console-time">{clockTime(row.at)}</time>
            <span className="console-tag">skipped</span>
            <span className="console-text">{row.reason}</span>
            <span className="console-source">{row.source}</span>
          </div>
        </li>
      )
    case 'log':
      return (
        <li className={`console-row log log-${row.log.level}`}>
          <div className="console-line">
            <span />
            <span className="console-tag">{row.log.phase}</span>
            <span className="console-text">{row.log.message}</span>
            <span className="console-source">{row.source}</span>
          </div>
        </li>
      )
    case 'error':
      return (
        <li className="console-row error">
          <div className="console-line">
            <span />
            <span className="console-tag">{row.error.phase} error</span>
            <span className="console-text">
              {row.error.line !== undefined && `Line ${row.error.line}: `}
              {row.error.message}
            </span>
            <span className="console-source">{row.source}</span>
          </div>
        </li>
      )
    case 'request':
      return <RequestRow entry={row.entry} source={row.source} open={open} onToggle={onToggle} />
  }
}

/** A request's line, which opens to show it and its response as raw text. */
function RequestRow(props: {
  entry: ResultEntry
  source: string
  open: boolean
  onToggle: () => void
}) {
  const { entry, open } = props
  const { result } = entry
  const { request, response } = result
  const failed = result.assertions.filter((assertion) => assertion.status === 'fail').length
  return (
    <li className={`console-row request status-${result.status}${open ? ' open' : ''}`}>
      <button type="button" className="console-line" aria-expanded={open} onClick={props.onToggle}>
        <time className="console-time">
          <span className="console-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          {clockTime(sentAt(entry))}
        </time>
        <span className="console-tag">
          <span className={`method m-${request.method.toLowerCase()}`}>{request.method}</span>
        </span>
        <span className="console-url">{request.url}</span>
        <span className="console-aside">
          <span className={`console-status ${response ? statusClass(response.status) : 'server'}`}>
            {outcomeOf(result)}
          </span>
          <span>{formatMs(response?.timings.totalMs ?? result.durationMs)}</span>
          {response && <span>{formatSize(response.sizeBytes)}</span>}
          {result.assertions.length > 0 && (
            <span className={`console-checks${failed > 0 ? ' fail' : ''}`}>
              {failed > 0
                ? `${failed} of ${result.assertions.length} checks failed`
                : `${result.assertions.length} check${result.assertions.length === 1 ? '' : 's'} passed`}
            </span>
          )}
          <span className="console-source">{props.source}</span>
        </span>
      </button>
      {open && <RequestDetail entry={entry} />}
    </li>
  )
}

function RequestDetail({ entry }: { entry: ResultEntry }) {
  const { result, run } = entry
  const { response } = result
  const failed = result.assertions.filter((assertion) => assertion.status === 'fail')
  const facts = [
    run?.environment ? `environment ${run.environment}` : null,
    response ? `TTFB ${formatMs(response.timings.ttfbMs)}` : null,
    response ? `total ${formatMs(response.timings.totalMs)}` : null,
    `step ${formatMs(result.durationMs)}`,
    response && response.redirectCount > 0
      ? `${response.redirectCount} redirect${response.redirectCount === 1 ? '' : 's'} to ${response.url}`
      : null
  ].filter(Boolean)
  return (
    <div className="console-detail">
      <div className="console-detail-head">
        <p className="console-facts">{facts.join(' · ')}</p>
        {response && (
          <CopyButton
            what="the request and response"
            label="Both"
            onCopy={() => window.desktop.app.copyText(rawExchange(result))}
          />
        )}
      </div>
      <div className="console-raw">
        <RawBlock title="Request" text={rawRequest(result.request)} />
        {response ? (
          <RawBlock title="Response" text={rawResponse(response)} />
        ) : (
          <section className="console-raw-block" aria-label="Raw response">
            <header>
              <h3>Response</h3>
            </header>
            <p className="console-none">
              No response{result.error ? `: ${result.error.message}` : ''}
            </p>
          </section>
        )}
      </div>
      {failed.length > 0 && (
        <ul className="console-failed" aria-label="Failed checks">
          {failed.map((assertion, i) => (
            <li key={i}>
              ✕ {assertion.name}
              {assertion.message ? ` — ${assertion.message}` : ''}
            </li>
          ))}
        </ul>
      )}
      {result.error?.stack && <pre className="console-stack">{result.error.stack}</pre>}
    </div>
  )
}

/** A request or response as raw text, drawn up to `DRAWN_TEXT`, with a Copy of all of it. */
function RawBlock({ title, text }: { title: string; text: string }) {
  const drawn = text.length > DRAWN_TEXT ? text.slice(0, DRAWN_TEXT) : text
  const what = `the ${title.toLowerCase()}`
  return (
    <section className="console-raw-block" aria-label={`Raw ${title.toLowerCase()}`}>
      <header>
        <h3>{title}</h3>
        <CopyButton what={what} onCopy={() => window.desktop.app.copyText(text)} />
      </header>
      <pre>{drawn}</pre>
      {drawn !== text && (
        <p className="hint">
          Showing the first {formatSize(DRAWN_TEXT)} of {formatSize(text.length)}: copying takes all
          of it.
        </p>
      )}
    </section>
  )
}
