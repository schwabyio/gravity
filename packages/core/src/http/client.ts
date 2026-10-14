import { Buffer, isUtf8 } from 'node:buffer'
import type { SecureContext, TLSSocket } from 'node:tls'
import {
  Agent,
  buildConnector,
  interceptors,
  request as undiciRequest,
  type Dispatcher
} from 'undici'
import type { BodyKind, HeaderEntry, ReceivedResponse, SentRequest } from '../model/run.js'
import {
  httpVersionOf,
  SETTINGS_DEFAULTS,
  type HttpVersion,
  type Settings
} from '../model/documents.js'
import { isEventStream } from '../model/eventStream.js'
import {
  EventStreamPump,
  OpenStream,
  readStream,
  waitsForEvents,
  type StreamRead,
  type StreamWatch,
  type TestsPass
} from './stream.js'
import {
  clearSecureContexts,
  isUntrustedCertificate,
  secureContextFor,
  trustKey,
  UNTRUSTED_HINT
} from './trust.js'
import { traced, track, type Trace } from './trace.js'

/** Statuses without a body, per RFC 9110. */
const BODYLESS_STATUSES = new Set([204, 304])

export interface SendOptions {
  /** The request's `settings` block; documented defaults are applied here. */
  settings?: Settings
  /** Abort the in-flight request (the desktop Cancel button, the CLI's watchdog). */
  signal?: AbortSignal
  /**
   * Certificates to trust, as PEM, on top of Node's bundled roots and the
   * operating system's trust store: a project's `tls.ca` (SPEC.md §1.1).
   */
  ca?: readonly string[]
  /**
   * The body's bytes, when they are not `spec.body`'s text: a file or a
   * multipart body, which `spec.body` only shows (SPEC.md §2.2).
   */
  payload?: Uint8Array | null
  /** For an event stream: the app's live view of its events, and its Stop button. */
  watch?: StreamWatch
  /**
   * For a step that opens a connection (SPEC.md §2.11): an event stream is
   * handed over here once the step's reading stops, open unless the server
   * closed it, with the events the step did not read. With none of
   * `maxEvents`, `streamTimeout` or `untilEvent` set, the step reads none of
   * its events: later steps do.
   */
  keep?: (stream: OpenStream) => void
  /**
   * For an event stream with `untilTestsPass` (SPEC.md §2.3): whether the
   * step's tests pass on what it has read so far, asked after each event.
   * Reading stops, as `testsPassed`, once they do.
   */
  passes?: (soFar: SoFar) => Promise<boolean>
}

/** An event stream as a step has read it so far: what its tests would see if it stopped now. */
export interface SoFar {
  request: SentRequest
  response: ReceivedResponse
  /** Whether the stream is still open. */
  open: boolean
}

export interface SendFailure {
  message: string
  code?: string
  /**
   * Milliseconds from handing the request to the HTTP client until it failed,
   * however it did: refused, timed out, cancelled, or closed with no answer.
   */
  elapsedMs: number
  /** Once its headers were sent: the HTTP version, and whether the connection was reused. */
  httpVersion?: Trace['httpVersion']
  connectionReused?: boolean
}

export type SendOutcome =
  | { ok: true; request: SentRequest; response: ReceivedResponse }
  | { ok: false; request: SentRequest; error: SendFailure }

/**
 * Every request goes through a dispatcher of ours, never undici's global one,
 * so that it trusts the operating system's CAs and the project's `tls.ca`
 * (./trust.ts). undici 8 dropped `maxRedirections` from `request()`, so
 * following redirects means composing the redirect interceptor onto the
 * dispatcher. Dispatchers own connection pools, so they are cached per
 * redirect limit, HTTP version and set of certificates, not built per request.
 */
const dispatchers = new Map<string, Dispatcher>()

function dispatcherFor(
  maxRedirections: number,
  version: HttpVersion,
  ca: readonly string[]
): Dispatcher {
  const key = `${maxRedirections}:${version}:${trustKey(ca)}`
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    const agent = agentFor(version, secureContextFor(ca))
    // `track` inside the redirect interceptor, so each request a redirect sends is traced.
    dispatcher =
      maxRedirections > 0
        ? agent.compose(track, interceptors.redirect({ maxRedirections }))
        : agent.compose(track)
    dispatchers.set(key, dispatcher)
  }
  return dispatcher
}

/**
 * `settings.httpVersion` (SPEC.md §2.3). `auto` is undici's own way: HTTP/2
 * when an https server picks it, HTTP/1.1 otherwise. `1.1` never offers
 * HTTP/2. `2` is HTTP/2 or nothing: an https server must pick it, and to an
 * http:// URL it is spoken in the clear from the start (h2c).
 */
function agentFor(version: HttpVersion, secureContext: SecureContext): Agent {
  if (version === '1.1') return new Agent({ allowH2: false, connect: { secureContext } })
  if (version === 'auto') return new Agent({ connect: { secureContext } })
  const connect = buildConnector({
    secureContext,
    allowH2: true,
    preferH2: true,
    // undici reads it, but its connector's types leave it out.
    ...{ useH2c: true }
  })
  return new Agent({
    connect: (options, callback) =>
      connect(options, (...args) => {
        const [error, socket] = args
        if (error || options.protocol !== 'https:' || (socket as TLSSocket).alpnProtocol === 'h2') {
          callback(...args)
          return
        }
        socket.destroy()
        callback(
          Object.assign(
            new Error(
              `${options.hostname} answered with HTTP/1.1, not HTTP/2, and httpVersion is 2`
            ),
            { code: 'NO_HTTP2' }
          ),
          null
        )
      })
  })
}

/** Release the pooled connections. Call on app quit or at the end of a CLI run. */
export async function closeHttpClients(): Promise<void> {
  const pending = [...dispatchers.values()].map((d) => d.close())
  dispatchers.clear()
  clearSecureContexts()
  await Promise.all(pending)
}

/**
 * Classify a body so the renderer can choose a highlighter without re-sniffing.
 * Content-Type wins; a JSON-shaped body with no useful type still reads as JSON.
 */
export function classifyBody(contentType: string | undefined, body: string): BodyKind {
  if (body.length === 0) return 'empty'
  if (isEventStream(contentType)) return 'events'
  const type = (contentType ?? '').toLowerCase()
  if (type.includes('json') || type.includes('+json')) return 'json'
  if (type.includes('xml') || type.includes('+xml')) return 'xml'
  if (type.includes('html')) return 'html'
  if (type.startsWith('text/')) return 'text'
  if (type !== '' && !type.startsWith('application/')) return 'binary'
  const head = body.trimStart()[0]
  if (head === '{' || head === '[') return 'json'
  if (head === '<') return 'xml'
  return type === '' ? 'text' : 'binary'
}

/** Percent-encode the parts of a URL that a hand-typed URL commonly leaves raw. */
function encodeUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).toString()
  } catch {
    // Leave anything unparseable alone; undici will report it.
    return rawUrl
  }
}

function toHeaderEntries(headers: Record<string, string | string[] | undefined>): HeaderEntry[] {
  const entries: HeaderEntry[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const v of value) entries.push({ name, value: v })
    else entries.push({ name, value })
  }
  return entries
}

/** Headers as undici takes them: a header given more than once is sent once per value. */
function headerRecord(headers: HeaderEntry[]): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {}
  for (const { name, value } of headers) {
    const before = record[name]
    record[name] =
      before === undefined ? value : [...(Array.isArray(before) ? before : [before]), value]
  }
  return record
}

/**
 * Send one HTTP request.
 *
 * Never throws for a transport failure: a failure comes back as
 * `{ ok: false, error }` so the caller always has the request it attempted.
 * Unlike a runner built on someone else's CLI, `settings.timeout` is honored
 * here, in our own client.
 *
 * A `text/event-stream` response is read as it arrives, until the server
 * closes it or `maxEvents`, `streamTimeout` or `EVENT_STREAM_LIMITS` stops it
 * (SPEC.md §2.3); `settings.timeout` covers only the wait for its headers.
 */
export async function sendHttpRequest(
  spec: SentRequest,
  options: SendOptions = {}
): Promise<SendOutcome> {
  const settings = { ...SETTINGS_DEFAULTS, ...options.settings }
  const url = settings.encodeUrl ? encodeUrl(spec.url) : spec.url
  const sent: SentRequest = { ...spec, url }

  const startedAt = Date.now()
  const startedHr = performance.now()

  // settings.timeout of 0 means "no limit", the default. It is one timer of
  // ours, not undici's headers and body timers: those can't be lifted once the
  // headers show an event stream, and they apply 5 minutes when given none.
  const timeoutMs = settings.timeout > 0 ? settings.timeout : undefined
  const timeout = new AbortController()
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => timeout.abort(new DOMException('The operation timed out.', 'TimeoutError')),
          timeoutMs
        )
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal

  const dispatcher = dispatcherFor(
    settings.followRedirects ? settings.maxRedirects : 0,
    httpVersionOf(settings.httpVersion),
    options.ca ?? []
  )
  const trace: Trace = {}

  try {
    const method = sent.method.toUpperCase() as Dispatcher.HttpMethod
    const response = await undiciRequest(url, {
      ...traced(trace),
      method,
      headers: headerRecord(sent.headers),
      body: options.payload ?? sent.body ?? undefined,
      dispatcher,
      signal,
      headersTimeout: 0,
      bodyTimeout: 0
    })

    const ttfbMs = performance.now() - startedHr
    const headers = toHeaderEntries(response.headers)
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
    // The redirect interceptor records the whole chain, starting with the URL asked for.
    const history = (response.context as ContextWithHistory | undefined)?.history ?? []
    const received = {
      status: response.statusCode,
      statusText: statusTextFor(response.statusCode),
      ...traceFields(trace),
      url: history.length > 0 ? String(history[history.length - 1]) : url,
      headers,
      redirectCount: Math.max(0, history.length - 1)
    }

    const bodyless = method === 'HEAD' || BODYLESS_STATUSES.has(response.statusCode)
    if (isEventStream(contentType) && !bodyless) {
      clearTimeout(timer)
      const pump = new EventStreamPump(response.body)
      let read: StreamRead
      try {
        read = await readStream(pump, settings, {
          // A step opening a connection waits only for what it says to; later steps read the rest.
          wait: !options.keep || waitsForEvents(settings),
          signal,
          ...streamWatching(options.watch, received),
          ...trying(options.passes, sent, received, { startedAt, ttfbMs, startedHr })
        })
      } catch (cause) {
        pump.close()
        throw cause
      }
      // Kept even once ended: what it still holds is for the steps that read it.
      if (options.keep) options.keep(new OpenStream(sent, received, pump))
      else pump.close()
      return {
        ok: true,
        request: sent,
        response: {
          ...eventsResponse(received, read),
          timings: { startedAt, ttfbMs, totalMs: performance.now() - startedHr }
        }
      }
    }

    const buffer = BODYLESS_STATUSES.has(response.statusCode)
      ? Buffer.alloc(0)
      : Buffer.from(await response.body.arrayBuffer())
    const totalMs = performance.now() - startedHr
    const text = buffer.toString('utf8')
    const bodyKind = classifyBody(contentType, text)
    // Bytes that are not text, an image's, would not survive being read as it: kept as base64.
    const base64 = bodyKind === 'binary' && !isUtf8(buffer)

    return {
      ok: true,
      request: sent,
      response: {
        ...received,
        body: base64 ? buffer.toString('base64') : text,
        bodyKind,
        ...(base64 ? { bodyEncoding: 'base64' as const } : {}),
        sizeBytes: buffer.byteLength,
        timings: { startedAt, ttfbMs, totalMs }
      }
    }
  } catch (cause) {
    return {
      ok: false,
      request: sent,
      error: {
        ...describeFailure(cause, timeoutMs, performance.now() - startedHr),
        ...traceFields(trace)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

interface ContextWithHistory {
  history?: Array<URL | string>
}

/** What a trace learned, leaving out what it did not. */
const traceFields = (trace: Trace): Trace => ({
  ...(trace.httpVersion ? { httpVersion: trace.httpVersion } : {}),
  ...(trace.connectionReused !== undefined ? { connectionReused: trace.connectionReused } : {})
})

/** The watch's part in one step's reading: its events, and the signal its Stop fires. */
function streamWatching(
  watch: StreamWatch | undefined,
  head: Pick<ReceivedResponse, 'status' | 'statusText'>
): { watch?: StreamWatch; stop?: AbortSignal } {
  if (!watch) return {}
  const stop = watch.open?.({ status: head.status, statusText: head.statusText })
  return { watch, ...(stop ? { stop } : {}) }
}

/** `passes` for `readStream`: the events read so far, as the step's response. */
function trying(
  passes: SendOptions['passes'],
  request: SentRequest,
  head: Parameters<typeof eventsResponse>[0],
  started: { startedAt: number; ttfbMs: number; startedHr: number }
): { passes?: TestsPass } {
  if (!passes) return {}
  const { startedAt, ttfbMs, startedHr } = started
  return {
    passes: (read, open) =>
      passes({
        request,
        response: {
          ...eventsResponse(head, read),
          timings: { startedAt, ttfbMs, totalMs: performance.now() - startedHr }
        },
        open
      })
  }
}

/** A response whose body is the events a step read. */
function eventsResponse(
  head: Omit<ReceivedResponse, 'body' | 'bodyKind' | 'sizeBytes' | 'timings' | 'stream'>,
  read: StreamRead
): Omit<ReceivedResponse, 'timings'> {
  return {
    ...head,
    body: read.text,
    bodyKind: 'events',
    sizeBytes: Buffer.byteLength(read.text),
    stream: { endedBy: read.endedBy, at: read.at }
  }
}

/**
 * Read the events a connection holds, and more as they arrive, for a step
 * reading it (SPEC.md §2.11). Its status and headers are those of the
 * response that opened it; `at` counts from that response's headers.
 *
 * With none of `maxEvents`, `streamTimeout` or `untilEvent` set, it takes the
 * events already held and ends. It never closes the connection.
 */
export async function readConnection(
  stream: OpenStream,
  options: Pick<SendOptions, 'settings' | 'signal' | 'watch' | 'passes'> = {}
): Promise<SendOutcome> {
  const settings = { ...SETTINGS_DEFAULTS, ...options.settings }
  const startedAt = Date.now()
  const startedHr = performance.now()
  try {
    const read = await readStream(stream.pump, settings, {
      wait: waitsForEvents(settings),
      ...(options.signal ? { signal: options.signal } : {}),
      ...streamWatching(options.watch, stream.head),
      ...trying(options.passes, stream.request, stream.head, { startedAt, ttfbMs: 0, startedHr })
    })
    return {
      ok: true,
      request: stream.request,
      response: {
        ...eventsResponse(stream.head, read),
        timings: { startedAt, ttfbMs: 0, totalMs: performance.now() - startedHr }
      }
    }
  } catch (cause) {
    return {
      ok: false,
      request: stream.request,
      error: {
        ...describeFailure(cause, undefined, performance.now() - startedHr),
        ...traceFields(stream.head)
      }
    }
  }
}

function describeFailure(
  cause: unknown,
  timeoutMs: number | undefined,
  elapsedMs: number
): SendFailure {
  const error = cause as { name?: string; code?: unknown; message?: string }
  // A DOMException's code is a number, 23 for our own timer's: not one to show.
  const code = typeof error?.code === 'string' ? error.code : undefined
  if (
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return {
      message: `Request timed out after ${timeoutMs}ms`,
      code: code ?? 'ETIMEDOUT',
      elapsedMs
    }
  }
  if (error?.name === 'AbortError' || code === 'ABORT_ERR') {
    return { message: 'Request cancelled', code: 'ABORTED', elapsedMs }
  }
  if (isUntrustedCertificate(code)) {
    // Node's own advice, --use-system-ca, is already taken: the system's CAs are trusted.
    const reason = (error.message ?? String(cause)).replace(
      /;\s*if the root CA is installed.*$/s,
      ''
    )
    return { message: `${reason}. ${UNTRUSTED_HINT}`, code, elapsedMs }
  }
  return {
    message: error?.message ?? String(cause),
    ...(code !== undefined ? { code } : {}),
    elapsedMs
  }
}

/** Minimal reason-phrase table; undici does not surface the one from the wire. */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
}

export function statusTextFor(status: number): string {
  if (STATUS_TEXT[status]) return STATUS_TEXT[status] as string
  if (status >= 100 && status < 200) return 'Informational'
  if (status < 300) return 'Success'
  if (status < 400) return 'Redirection'
  if (status < 500) return 'Client Error'
  return 'Server Error'
}
