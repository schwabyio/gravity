import diagnostics from 'node:diagnostics_channel'
import type { Dispatcher } from 'undici'

/**
 * What one send learned of the connection it went out on: the HTTP version,
 * and whether the connection was new or one kept open from an earlier
 * request. A server or proxy that closes idle connections sooner than the
 * client expects drops a request sent on one it already closed, so a request
 * that failed on a reused connection points there. With redirects, the last
 * request sent is the one described. Nothing is known of a request that never
 * got as far as its headers: refused, or a failed TLS handshake.
 */
export interface Trace {
  httpVersion?: 'HTTP/1.1' | 'HTTP/2'
  connectionReused?: boolean
}

/**
 * undici says what it does on diagnostics channels: a request created, its
 * headers sent on a socket. Node's own fetch says so on the same channels, so
 * a request is only ours when a send of ours created it.
 */
const TRACE = Symbol('gravity.trace')

/** The send whose dispatch is on the stack: undici creates its request synchronously. */
let current: Trace | null = null
const owners = new WeakMap<object, Trace>()
/** Sockets that have carried a request: one seen again is a reused connection. */
const carried = new WeakSet<object>()

diagnostics.subscribe('undici:request:create', (message) => {
  if (current) owners.set((message as { request: object }).request, current)
})

diagnostics.subscribe('undici:client:sendHeaders', (message) => {
  const { request, socket } = message as { request: object; socket: { alpnProtocol?: unknown } }
  const reused = carried.has(socket)
  carried.add(socket)
  const trace = owners.get(request)
  if (!trace) return
  trace.connectionReused = reused
  // `h2` over TLS, or set by undici for cleartext HTTP/2; anything else is HTTP/1.1.
  trace.httpVersion = socket.alpnProtocol === 'h2' ? 'HTTP/2' : 'HTTP/1.1'
})

/** The request options that tie a send to its trace; undici carries them to every redirect. */
export const traced = (trace: Trace): Record<symbol, Trace> => ({ [TRACE]: trace })

/**
 * An interceptor that marks the trace's send as current while undici creates
 * each of its requests. Composed inside the redirect interceptor, so a redirect's
 * next request, created later, is still the send's.
 */
export const track: Dispatcher.DispatcherComposeInterceptor = (dispatch) => (options, handler) => {
  const before = current
  current = (options as unknown as Record<symbol, Trace | undefined>)[TRACE] ?? null
  try {
    return dispatch(options, handler)
  } finally {
    current = before
  }
}
