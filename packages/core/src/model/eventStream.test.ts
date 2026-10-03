import { describe, expect, it } from 'vitest'
import {
  EventStreamParser,
  isEventStream,
  parseEventStream,
  type ParsedEvent
} from './eventStream.js'

describe('parseEventStream', () => {
  it('reads each event, with its data as JSON when it parses', () => {
    const body = [
      'event: subscribed',
      'data: {"symbol":"ACME"}',
      '',
      ': heartbeat',
      '',
      'id: 41',
      'event: price',
      'data: {"symbol":"ACME","price":100}',
      '',
      'data: [DONE]',
      '',
      ''
    ].join('\n')
    expect(parseEventStream(body)).toEqual([
      { event: 'subscribed', data: { symbol: 'ACME' } },
      { event: 'price', id: '41', data: { symbol: 'ACME', price: 100 } },
      { data: '[DONE]' }
    ])
  })

  it('keeps data that is not JSON as its text, and JSON scalars as themselves', () => {
    expect(
      parseEventStream('data: hello world\n\ndata: 42\n\ndata: "quoted"\n\ndata:\n\n')
    ).toEqual([{ data: 'hello world' }, { data: 42 }, { data: 'quoted' }, { data: '' }])
  })

  it('joins data lines with a line feed, so JSON may span them', () => {
    expect(
      parseEventStream('data: first\ndata: second\n\ndata: {\ndata: "a": 1\ndata: }\n\n')
    ).toEqual([{ data: 'first\nsecond' }, { data: { a: 1 } }])
  })

  it('takes LF, CRLF or CR as a line end, and drops a leading BOM', () => {
    const events = [{ event: 'a', data: 1 }, { data: 2 }]
    expect(parseEventStream('event: a\ndata: 1\n\ndata: 2\n\n')).toEqual(events)
    expect(parseEventStream('event: a\r\ndata: 1\r\n\r\ndata: 2\r\n\r\n')).toEqual(events)
    expect(parseEventStream('event: a\rdata: 1\r\rdata: 2\r\r')).toEqual(events)
    expect(parseEventStream('﻿event: a\ndata: 1\n\ndata: 2\n\n')).toEqual(events)
  })

  it('strips one space after the colon, and reads a line with no colon as an empty field', () => {
    expect(parseEventStream('data:  two spaces\n\ndata:none\n\ndata\n\n')).toEqual([
      { data: ' two spaces' },
      { data: 'none' },
      { data: '' }
    ])
  })

  it('is not an event without data, and carries no id or event over to the next', () => {
    expect(
      parseEventStream('id: 7\nevent: ping\n\nretry: 3000\n\ndata: next\n\nid: 8\ndata: own\n\n')
    ).toEqual([{ data: 'next' }, { id: '8', data: 'own' }])
  })

  it('ignores an id holding NUL, and fields it does not know', () => {
    expect(parseEventStream('id: a\0b\nfoo: bar\ndata: x\n\n')).toEqual([{ data: 'x' }])
  })

  it('discards an event still unfinished when the body ends', () => {
    expect(parseEventStream('data: done\n\ndata: half')).toEqual([{ data: 'done' }])
    expect(parseEventStream('data: done\n\ndata: half\n')).toEqual([{ data: 'done' }])
    expect(parseEventStream('')).toEqual([])
  })
})

describe('EventStreamParser', () => {
  const STREAM = '﻿event: a\r\ndata: {"n":1}\r\n\r\n: note\r\ndata: two\r\r\nid: 3\ndata: 3\n\n'

  const whole = new EventStreamParser().push(STREAM)

  it('says where each event ends, line break included', () => {
    expect(whole.map(({ event }) => event)).toEqual([
      { event: 'a', data: { n: 1 } },
      { data: 'two' },
      { id: '3', data: 3 }
    ])
    for (const { end } of whole) expect(['\n', '\r']).toContain(STREAM[end - 1])
    // Cut there, the text reads as the same events, up to that one.
    for (const [index, { end }] of whole.entries()) {
      expect(parseEventStream(STREAM.slice(0, end))).toEqual(
        whole.slice(0, index + 1).map(({ event }) => event)
      )
    }
  })

  /**
   * The same events as the whole text, ending where it says or, for a CRLF
   * split between pieces, at its CR: an event is complete there, and is not
   * held back to see whether an LF follows.
   */
  const sameAsWhole = (events: ParsedEvent[], why: string) => {
    expect(
      events.map(({ event }) => event),
      why
    ).toEqual(whole.map(({ event }) => event))
    for (const [index, { end }] of events.entries()) {
      const expected = whole[index]!.end
      expect(end === expected || (end === expected - 1 && STREAM[end - 1] === '\r'), why).toBe(true)
    }
  }

  it('reads the same however the text is split, a CRLF included', () => {
    for (let at = 0; at <= STREAM.length; at++) {
      const parser = new EventStreamParser()
      const events = [...parser.push(STREAM.slice(0, at)), ...parser.push(STREAM.slice(at))]
      sameAsWhole(events, `split at ${at}`)
    }
  })

  it('reads the same pushed a character at a time, empty pushes and all', () => {
    const parser = new EventStreamParser()
    const events = [...STREAM].flatMap((char) => [...parser.push(char), ...parser.push('')])
    sameAsWhole(events, 'a character at a time')
  })
})

describe('isEventStream', () => {
  it('matches the media type, in any case, with or without parameters', () => {
    expect(isEventStream('text/event-stream')).toBe(true)
    expect(isEventStream('Text/Event-Stream; charset=utf-8')).toBe(true)
    expect(isEventStream('text/plain')).toBe(false)
    expect(isEventStream('application/json')).toBe(false)
    expect(isEventStream(undefined)).toBe(false)
  })
})
