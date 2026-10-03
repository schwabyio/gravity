/**
 * A `text/event-stream` body as the list of events checks see (SPEC.md §3).
 *
 * Pure, and shared: the HTTP client feeds a stream through it as it arrives,
 * to count events, and `bodyAsObject` reads a finished body with it, so the
 * engine and the app always see the same events.
 */

/** One event. `event` and `id` are present only when the event's own lines set them. */
export interface StreamEvent {
  event?: string
  id?: string
  /** The data lines joined with a line feed: their JSON value when they parse, else the text. */
  data: unknown
}

/**
 * An event, and where it ends in all the text pushed so far, line break
 * included. A CRLF split between two pushes ends it at the CR: the event is
 * complete there, so it isn't held back to see whether an LF follows.
 */
export interface ParsedEvent {
  event: StreamEvent
  end: number
}

/**
 * Reads an event stream pushed in pieces, by the WHATWG HTML rules: LF, CRLF
 * or CR line ends, a leading BOM, `:` comments, one space after the colon
 * stripped, and a block with no `data` not an event. Unlike a browser, it
 * keeps no `id` or `event` past the event that set it, since a test checks
 * what the server sent with each one. `retry` is ignored.
 *
 * An event is complete at the blank line after it. Text after the last one is
 * an unfinished event, discarded if the stream ends there.
 */
export class EventStreamParser {
  /** Text after the last line break: the start of a line still arriving. */
  private pending = ''
  /** Where `pending` starts in all the text pushed. */
  private offset = 0
  private started = false
  /** The last piece ended with a CR, so an LF starting the next ends the same line. */
  private afterCR = false
  private type: string | undefined
  private id: string | undefined
  private data: string[] | null = null

  push(text: string): ParsedEvent[] {
    const events: ParsedEvent[] = []
    const buffer = this.pending + text
    let pos = 0
    if (!this.started && buffer.length > 0) {
      this.started = true
      if (buffer.startsWith('﻿')) pos = 1
    }
    if (this.afterCR && buffer.length > pos) {
      this.afterCR = false
      if (buffer[pos] === '\n') pos++
    }
    // `pending` holds no line break, so the search starts after it.
    const lineEnd = /\r\n?|\n/g
    lineEnd.lastIndex = Math.max(pos, this.pending.length)
    for (let match = lineEnd.exec(buffer); match; match = lineEnd.exec(buffer)) {
      const line = buffer.slice(pos, match.index)
      pos = match.index + match[0].length
      if (match[0] === '\r' && pos === buffer.length) this.afterCR = true
      const event = this.line(line)
      if (event) events.push({ event, end: this.offset + pos })
    }
    this.pending = buffer.slice(pos)
    this.offset += pos
    return events
  }

  private line(line: string): StreamEvent | null {
    if (line === '') return this.dispatch()
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.type = value
    else if (field === 'data') (this.data ??= []).push(value)
    else if (field === 'id' && !value.includes('\0')) this.id = value
    return null
  }

  private dispatch(): StreamEvent | null {
    const { type, id, data } = this
    this.type = undefined
    this.id = undefined
    this.data = null
    if (data === null) return null
    return {
      ...(type !== undefined ? { event: type } : {}),
      ...(id !== undefined ? { id } : {}),
      data: dataValue(data.join('\n'))
    }
  }
}

function dataValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Every complete event in a finished body. */
export function parseEventStream(body: string): StreamEvent[] {
  return new EventStreamParser().push(body).map(({ event }) => event)
}

/** Whether a Content-Type names an event stream. */
export function isEventStream(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]!.trim().toLowerCase() === 'text/event-stream'
}
