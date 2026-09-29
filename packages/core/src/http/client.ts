import { Buffer } from 'node:buffer'
import { Agent, interceptors, request as undiciRequest, type Dispatcher } from 'undici'
import type { BodyKind, HeaderEntry, ReceivedResponse, SentRequest } from '../model/run.js'
import { SETTINGS_DEFAULTS, type Settings } from '../model/documents.js'
import {
  clearSecureContexts,
  isUntrustedCertificate,
  secureContextFor,
  trustKey,
  UNTRUSTED_HINT
} from './trust.js'

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
}

export interface SendFailure {
  message: string
  code?: string
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
 * redirect limit and set of certificates, not built per request.
 */
const dispatchers = new Map<string, Dispatcher>()

function dispatcherFor(maxRedirections: number, ca: readonly string[]): Dispatcher {
  const key = `${maxRedirections}:${trustKey(ca)}`
  let dispatcher = dispatchers.get(key)
  if (!dispatcher) {
    const agent = new Agent({ connect: { secureContext: secureContextFor(ca) } })
    dispatcher =
      maxRedirections > 0 ? agent.compose(interceptors.redirect({ maxRedirections })) : agent
    dispatchers.set(key, dispatcher)
  }
  return dispatcher
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

function headerRecord(headers: HeaderEntry[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const { name, value } of headers) record[name] = value
  return record
}

/**
 * Send one HTTP request.
 *
 * Never throws for a transport failure: a failure comes back as
 * `{ ok: false, error }` so the caller always has the request it attempted.
 * Unlike a runner built on someone else's CLI, `settings.timeout` is honored
 * here, in our own client.
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

  // settings.timeout of 0 means "no limit", the default.
  const timeoutMs = settings.timeout > 0 ? settings.timeout : undefined
  const signals: AbortSignal[] = []
  if (options.signal) signals.push(options.signal)
  if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs))

  const dispatcher = dispatcherFor(
    settings.followRedirects ? settings.maxRedirects : 0,
    options.ca ?? []
  )

  try {
    const response = await undiciRequest(url, {
      method: sent.method.toUpperCase() as Dispatcher.HttpMethod,
      headers: headerRecord(sent.headers),
      body: options.payload ?? sent.body ?? undefined,
      dispatcher,
      ...(signals.length > 0 ? { signal: AbortSignal.any(signals) } : {}),
      ...(timeoutMs !== undefined ? { headersTimeout: timeoutMs, bodyTimeout: timeoutMs } : {})
    })

    const ttfbMs = performance.now() - startedHr

    const buffer = BODYLESS_STATUSES.has(response.statusCode)
      ? Buffer.alloc(0)
      : Buffer.from(await response.body.arrayBuffer())
    const totalMs = performance.now() - startedHr

    const headers = toHeaderEntries(response.headers)
    const contentType = headers.find((h) => h.name.toLowerCase() === 'content-type')?.value
    const body = buffer.toString('utf8')

    // The redirect interceptor records the whole chain, starting with the URL asked for.
    const history = (response.context as ContextWithHistory | undefined)?.history ?? []

    return {
      ok: true,
      request: sent,
      response: {
        status: response.statusCode,
        statusText: statusTextFor(response.statusCode),
        url: history.length > 0 ? String(history[history.length - 1]) : url,
        headers,
        body,
        bodyKind: classifyBody(contentType, body),
        sizeBytes: buffer.byteLength,
        redirectCount: Math.max(0, history.length - 1),
        timings: { startedAt, ttfbMs, totalMs }
      }
    }
  } catch (cause) {
    return { ok: false, request: sent, error: describeFailure(cause, timeoutMs) }
  }
}

interface ContextWithHistory {
  history?: Array<URL | string>
}

function describeFailure(cause: unknown, timeoutMs: number | undefined): SendFailure {
  const error = cause as { name?: string; code?: string; message?: string }
  const code = error?.code
  if (
    error?.name === 'TimeoutError' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT'
  ) {
    return { message: `Request timed out after ${timeoutMs}ms`, code: code ?? 'ETIMEDOUT' }
  }
  if (error?.name === 'AbortError' || code === 'ABORT_ERR') {
    return { message: 'Request cancelled', code: 'ABORTED' }
  }
  if (isUntrustedCertificate(code)) {
    // Node's own advice, --use-system-ca, is already taken: the system's CAs are trusted.
    const reason = (error.message ?? String(cause)).replace(
      /;\s*if the root CA is installed.*$/s,
      ''
    )
    return { message: `${reason}. ${UNTRUSTED_HINT}`, code }
  }
  return {
    message: error?.message ?? String(cause),
    ...(code !== undefined ? { code } : {})
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
