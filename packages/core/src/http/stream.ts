import { Buffer } from 'node:buffer'
import type { Dispatcher } from 'undici'
import type { Settings } from '../model/documents.js'
import { EventStreamParser, type StreamEvent } from '../model/eventStream.js'
import type { ReceivedResponse, SentRequest, StreamEnd } from '../model/run.js'

/**
 * The most an event stream keeps, whatever its settings, so a chatty stream
 * with no other limit cannot exhaust the run worker (SPEC.md §2.3): the most
 * one step reads, and the most a connection holds between steps.
 */
export const EVENT_STREAM_LIMITS = { events: 1000, bytes: 10 * 1024 * 1024 } as const

/** An event as it arrived: the event, its text since the end of the one before, and when. */
export interface HeldEvent {
  event: StreamEvent
  text: string
  /** Milliseconds from the response headers. */
  at: number
}

/** Watching a step read an event stream: the app's live view and its Stop button. */
export interface StreamWatch {
  /**
   * A step starts reading a stream: its headers arrived, or it reads a
   * connection. The signal returned stops this reading, as a normal end.
   */
  open?: (opened: { status: number; statusText: string }) => AbortSignal | undefined
  /** Each event the step takes, in order. */
  event?: (event: StreamEvent, at: number) => void
}

/** How a stream came to give no more. */
type Ended = { by: 'close' | 'limit' } | { error: unknown }

/**
 * Reads an event stream's body as it arrives, holding its events until a step
 * takes them. A step's reading takes them as they come; a connection keeps
 * the pump running between steps (SPEC.md §2.11).
 *
 * It stops at the server's close, a failure, `close()`, or when what it holds
 * reaches `EVENT_STREAM_LIMITS`.
 */
export class EventStreamPump {
  /** When the headers arrived: what `at` counts from. */
  readonly headersAt = performance.now()
  private readonly held: HeldEvent[] = []
  /** Text after the last event: one still arriving, or an unfinished one at the end. */
  private pending = ''
  /** Bytes held: the held events' and `pending`'s, roughly. */
  private bytes = 0
  private ended: Ended | null = null
  private closing = false
  private waiters: Array<() => void> = []
  /** Something changed: an event held or taken, or the end. */
  onChange?: () => void

  constructor(private readonly body: Dispatcher.ResponseData['body']) {
    void this.pump()
  }

  /** How many events are held, waiting for a step. */
  get count(): number {
    return this.held.length
  }

  /** How it ended, once it has. */
  get end(): Ended | null {
    return this.ended
  }

  /** Text that arrived after the last event, when the stream has ended. */
  get tail(): string {
    return this.ended ? this.pending : ''
  }

  /** The next held event, if there is one. */
  take(): HeldEvent | undefined {
    const next = this.held.shift()
    if (next) {
      this.bytes -= Buffer.byteLength(next.text)
      this.onChange?.()
    }
    return next
  }

  /** Resolves once an event is held or the stream ends. */
  changed(): Promise<void> {
    if (this.held.length > 0 || this.ended) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Stop reading and close the connection. Held events stay held. */
  close(): void {
    if (this.ended) return
    this.closing = true
    this.body.destroy()
  }

  private notify(): void {
    const waiting = this.waiters
    this.waiters = []
    for (const wake of waiting) wake()
    this.onChange?.()
  }

  private finish(ended: Ended): void {
    if (this.ended) return
    this.ended = ended
    this.notify()
  }

  private async pump(): Promise<void> {
    const parser = new EventStreamParser()
    const decoder = new TextDecoder()
    /** Where `pending` starts, in all the text pushed to the parser. */
    let offset = 0
    try {
      for await (const chunk of this.body as AsyncIterable<Buffer>) {
        this.bytes += chunk.byteLength
        const piece = decoder.decode(chunk, { stream: true })
        this.pending += piece
        const events = parser.push(piece)
        for (const { event, end } of events) {
          const text = this.pending.slice(0, end - offset)
          this.pending = this.pending.slice(end - offset)
          offset = end
          this.held.push({ event, text, at: performance.now() - this.headersAt })
        }
        if (events.length > 0) this.notify()
        if (
          this.held.length >= EVENT_STREAM_LIMITS.events ||
          this.bytes >= EVENT_STREAM_LIMITS.bytes
        ) {
          this.closing = true
          this.body.destroy()
          this.finish({ by: 'limit' })
          return
        }
      }
      this.pending += decoder.decode()
      this.finish({ by: 'close' })
    } catch (error) {
      // Destroying the body to close it makes undici report it aborted: that is a close.
      this.finish(this.closing ? { by: 'close' } : { error })
    }
  }
}

/** Whether a step on a connection waits for anything: it sets maxEvents, streamTimeout or untilEvent. */
export const waitsForEvents = (settings: Required<Settings>): boolean =>
  settings.maxEvents > 0 || settings.streamTimeout > 0 || settings.untilEvent !== ''

export interface StreamRead {
  text: string
  at: number[]
  endedBy: StreamEnd
}

/**
 * Take events from a stream for one step, until whichever comes first: the
 * stream ends, `maxEvents` events, the event `untilEvent` names,
 * `streamTimeout` milliseconds, the safety limit, or `stop`. Each is a
 * normal end. With `wait: false` it takes only the events already held.
 *
 * Anything else that ends it — Cancel, a dropped connection — throws, once
 * the events held before it are taken.
 */
export async function readStream(
  pump: EventStreamPump,
  settings: Required<Settings>,
  options: { wait: boolean; signal?: AbortSignal; stop?: AbortSignal; watch?: StreamWatch }
): Promise<StreamRead> {
  const maxEvents =
    settings.maxEvents > 0
      ? Math.min(settings.maxEvents, EVENT_STREAM_LIMITS.events)
      : EVENT_STREAM_LIMITS.events
  const cleanup: Array<() => void> = []
  type Interruption = 'streamTimeout' | 'stopped' | 'cancelled'
  /** Why a timer or a signal ended the reading, once one has. */
  let interruption: Interruption | null = null
  const interrupted = new Promise<Interruption>((resolve) => {
    const interrupt = (why: Interruption) => {
      interruption ??= why
      resolve(why)
    }
    if (settings.streamTimeout > 0) {
      const timer = setTimeout(() => interrupt('streamTimeout'), settings.streamTimeout)
      cleanup.push(() => clearTimeout(timer))
    }
    for (const [signal, why] of [
      [options.stop, 'stopped'],
      [options.signal, 'cancelled']
    ] as const) {
      if (!signal) continue
      if (signal.aborted) interrupt(why)
      const listener = () => interrupt(why)
      signal.addEventListener('abort', listener, { once: true })
      cleanup.push(() => signal.removeEventListener('abort', listener))
    }
  })
  const cancelled = () =>
    options.signal?.reason ?? new DOMException('This operation was aborted', 'AbortError')
  const at: number[] = []
  let text = ''
  let bytes = 0
  try {
    for (;;) {
      const why = interruption as Interruption | null
      if (why === 'cancelled') throw cancelled()
      if (why) return { text, at, endedBy: why }
      const item = pump.take()
      if (item) {
        at.push(item.at)
        text += item.text
        bytes += Buffer.byteLength(item.text)
        options.watch?.event?.(item.event, item.at)
        if (at.length === maxEvents) {
          return { text, at, endedBy: maxEvents === settings.maxEvents ? 'maxEvents' : 'limit' }
        }
        if (settings.untilEvent !== '' && item.event.event === settings.untilEvent) {
          return { text, at, endedBy: 'untilEvent' }
        }
        if (bytes >= EVENT_STREAM_LIMITS.bytes) return { text, at, endedBy: 'limit' }
        continue
      }
      const end = pump.end
      if (end) {
        if ('error' in end) throw end.error
        return { text: text + pump.tail, at, endedBy: end.by }
      }
      if (!options.wait) return { text, at, endedBy: 'held' }
      await Promise.race([pump.changed(), interrupted])
    }
  } finally {
    for (const undo of cleanup) undo()
  }
}

/** What a stream's response was, without its body: a connection keeps it for the steps that read it. */
export type StreamHead = Pick<
  ReceivedResponse,
  'status' | 'statusText' | 'url' | 'headers' | 'redirectCount'
>

/** An event stream kept open after the step that opened it: a connection (SPEC.md §2.11). */
export class OpenStream {
  constructor(
    /** The request that opened it, as sent. */
    readonly request: SentRequest,
    readonly head: StreamHead,
    readonly pump: EventStreamPump
  ) {}

  close(): void {
    this.pump.close()
  }
}
