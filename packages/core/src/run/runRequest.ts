import assert from 'node:assert/strict'
import { CheckSession } from '../assert/session.js'
import { readConnection, sendHttpRequest, type SendOutcome } from '../http/client.js'
import type { OpenStream, StreamWatch } from '../http/stream.js'
import type { Body, Collection, Step, VarValue } from '../model/documents.js'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  stepLabel,
  type Before,
  type Headers,
  type Settings
} from '../model/documents.js'
import {
  deriveStatus,
  type ReceivedResponse,
  type LogEntry,
  type RunError,
  type RunResult,
  type SentRequest
} from '../model/run.js'
import {
  newStepControl,
  preRequestGta,
  headerMap,
  requestView,
  responseView,
  testsGta,
  type StepControl
} from '../runtime/gta.js'
import { runScript, type Adopt } from '../runtime/sandbox.js'
import { loadLibrary, type CheckFile, type EndpointBase } from '../workspace/library.js'
import type { ProjectTrust } from '../workspace/projectTls.js'
import { findEndpoint, placeholdersOf } from '../model/endpoints.js'
import { foldLayers, requestLayers, type LayerKind } from '../model/layers.js'
import { buildScope, type ScopeContext } from '../vars/resolve.js'
import { InterpolationError, OverlayScope, ParamsScope, VariableScope } from '../vars/scope.js'
import { interpolateToString } from '../vars/interpolate.js'
import { resolveSettings, toSentRequest } from './buildRequest.js'
import { fileRootsOf, resolveParams } from './plan.js'
import { BodyFileError, bodyFiles, prepareRequest, type FileRoots } from './prepareRequest.js'
import type { Connections } from './connections.js'

export interface RunStepInput {
  step: Step
  /** The collection it belongs to, for shared headers, settings and `before`. */
  collection?: Collection
  /** Collection-relative identity for reports; null for an ad-hoc request. */
  itemPath?: string | null
  signal?: AbortSignal
  /** Where to resolve variables from. Omit for a request with no collection. */
  context?: ScopeContext
  /**
   * A scope to use instead of building one.
   *
   * The collection runner passes a single scope through a sequence of steps so
   * that a value captured by one is visible to the next.
   */
  scope?: VariableScope
  /** When the step is one of a request set's, run by a use step (SPEC.md §2.5). */
  set?: SetRun
  /** Check files, reachable from every script as `checks.<name>`. */
  checks?: CheckFile[]
  /** Params for a request set run on its own; a set run by a use step brings its own. */
  params?: Record<string, VarValue>
  /** Endpoint bases to match the step against; absent, read from its project. */
  endpoints?: EndpointBase[]
  /**
   * The base collection the collection `extends:`, resolved; absent, resolved
   * from its project; null for none.
   */
  base?: Collection | null
  /** The certificates the project trusts (SPEC.md §1.1); absent, read from its project. */
  tls?: ProjectTrust
  /** For a step with `forEach`: the item this request is for, and where it is in the list. */
  item?: ForEachItem
  /** Where the step's scripts record `gta.skip` and `gta.skipRest`; absent, the step's own. */
  control?: StepControl
  /**
   * The run's connections (SPEC.md §2.11): where a step with `connection:`
   * keeps the event stream it opens, and where a step reading one finds it.
   */
  connections?: Connections
  /** For an event stream: the app's live view of its events, and its Stop button. */
  watch?: StreamWatch
}

/** One item of a step's `forEach` list (SPEC.md §2.1). */
export interface ForEachItem {
  /** As the list held it: `item` in code. */
  value: unknown
  index: number
  of: number
}

/** An item as a variable holds it: `{{item}}`. An object or a list is its JSON. */
export const itemText = (value: unknown): VarValue =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)
    ? (value as VarValue)
    : (JSON.stringify(value) ?? String(value))

/** One layer of what a request is made of, outermost first (SPEC.md §2.6–2.7). */
interface Layer {
  script: NonNullable<RunError['script']>
  /** For stack traces and messages: `endpoint tests`, `base before.script`. */
  label: string
  headers?: Headers | undefined
  settings?: Settings | undefined
  before?: Before | undefined
  tests?: string | undefined
  /** An endpoint base's checks: a later check of the same thing replaces them. */
  defaults?: boolean
}

/** A request set's step being run for a use step. */
export interface SetRun {
  /** As the use step named it. */
  name: string
  /** The use step's own `name`, when it has one. */
  useName?: string
  /** Its file: the files its steps' bodies name are read from its project's folder. */
  path?: string
  /** The set: its headers, settings, `before` and `tests` apply to each of its steps. */
  doc: Collection
  /**
   * Its params: `params.<name>` in its scripts, `{{params.<name>}}` in its
   * requests. Asked for as the set's own layer begins, once the caller's
   * endpoint, base and collection `before.script` have run (SPEC.md §2.5);
   * resolved the first time, and throwing when they cannot be.
   */
  params: () => Record<string, VarValue>
  /** Which of its steps this is, 0-based, and how many it has. */
  child: number
  of: number
  /** The use step's own `tests`, run on the step marked `useTests`, else the set's last. */
  useTests?: string | undefined
}

/**
 * What a step is sent with: every layer's headers and settings folded, the
 * outermost first, so each nearer one wins; the step's own go on top when the
 * request is built.
 */
function folded(layers: Layer[], collection: Collection | undefined): Collection {
  const { headers, settings } = foldLayers(layers)
  return {
    ...collection,
    steps: [],
    ...(headers ? { headers } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
}

/** How a run names each layer: in stack traces, results and messages. */
const ROLES: Record<LayerKind, Pick<Layer, 'script' | 'label' | 'defaults'>> = {
  // An endpoint base's checks are defaults: the step's own of the same thing replace them.
  'endpoint-file': { script: 'endpoint-file', label: 'endpoint file', defaults: true },
  endpoint: { script: 'endpoint', label: 'endpoint', defaults: true },
  base: { script: 'base', label: 'base' },
  collection: { script: 'collection', label: 'collection' },
  set: { script: 'set', label: 'set' },
  step: { script: 'step', label: '' }
}

/** Whether the run has to read the project for checks, endpoints, a base or `tls`. */
const needsLibrary = (input: RunStepInput) =>
  input.checks === undefined ||
  input.endpoints === undefined ||
  input.tls === undefined ||
  (input.base === undefined && input.collection?.extends !== undefined)

/** The endpoint base a step's request is for, if any. */
function endpointFor(step: Step, endpoints: EndpointBase[]): EndpointBase | null {
  if (isUseStep(step) || isReadStep(step) || endpoints.length === 0) return null
  const { method, url } = readRequestLine(step)
  return findEndpoint(method, url, endpoints)
}

/**
 * The values of a matched endpoint's `{name}`s — `endpoint.id` — from the
 * step's URL, resolved now. One that cannot be resolved yet reads as written.
 */
function endpointValues(endpoint: EndpointBase, step: Step, scope: VariableScope) {
  const { url } = readRequestLine(step)
  const values: Record<string, string> = {}
  for (const [name, segment] of Object.entries(placeholdersOf(endpoint.path, url))) {
    try {
      values[name] = interpolateToString(segment, scope)
    } catch {
      values[name] = segment
    }
  }
  return values
}

/**
 * Run a single step and produce the `RunResult` every consumer renders.
 *
 * In order: `before.script` (collection, then step), the
 * request, then the checks — `tests` code, collection then step, feeding one
 * `CheckSession`, closed by strict
 * validation once everything that could account for a property has run.
 */
export async function runRequest(input: RunStepInput): Promise<RunResult> {
  const { step, itemPath = null, signal, context, scope: provided, set, item: each } = input
  const control = input.control ?? newStepControl()
  if (isUseStep(step)) {
    // A use step is a list of requests; the collection runner expands it.
    return {
      item: { path: itemPath, name: stepLabel(step), seq: null },
      request: { method: 'GET', url: '', headers: [], body: null },
      response: null,
      assertions: [],
      error: { phase: 'use', message: `use: ${step.use} — run it with runCollection` },
      status: 'error',
      durationMs: 0
    }
  }
  const library = context && needsLibrary(input) ? await loadLibrary(context.collectionPath) : null
  const checks = input.checks ?? library?.checks
  const endpoints = input.endpoints ?? library?.endpoints ?? []
  const tls = input.tls ?? library?.tls
  let base: Collection | null = null
  try {
    base =
      input.base !== undefined
        ? input.base
        : input.collection?.extends && library
          ? await library.base(input.collection.extends)
          : null
  } catch (cause) {
    return failedBeforeSending(
      step,
      input.collection,
      { path: itemPath, name: stepLabel(step), seq: null },
      { phase: 'use', message: (cause as Error).message },
      performance.now(),
      []
    )
  }
  // The connection a step reads, which must be open: it sends no request of its own.
  const reading = isReadStep(step) ? input.connections?.get(step.connection) : undefined
  if (isReadStep(step) && !reading) {
    return failedBeforeSending(
      step,
      input.collection,
      { path: itemPath, name: stepLabel(step), seq: null },
      {
        phase: 'connection',
        message: `No connection named ${step.connection} is open. A step with connection: ${step.connection} beside its method opens it; run that step first (SPEC.md §2.11)`
      },
      performance.now(),
      []
    )
  }
  // A tls.ca file that cannot be read: send nothing, rather than fail later with a vaguer TLS error.
  if (tls && tls.problems.length > 0 && !reading) {
    return failedBeforeSending(
      step,
      input.collection,
      { path: itemPath, name: stepLabel(step), seq: null },
      {
        phase: 'http',
        message: `A certificate in tls.ca cannot be used — ${tls.problems
          .map((problem) => `${problem.path}: ${problem.message}`)
          .join('; ')}`
      },
      performance.now(),
      []
    )
  }
  // The endpoint this request is for, unless the step says not to use one.
  const endpoint = step.base === false ? null : endpointFor(step, endpoints)
  const startedHr = performance.now()
  const name = stepLabel(step)
  const item = { path: itemPath, name, seq: null }
  const logs: LogEntry[] = []
  const withLogs = () => ({
    ...(logs.length > 0 ? { logs } : {}),
    ...(each
      ? { forEach: { index: each.index, of: each.of, item: String(itemText(each.value)) } }
      : {}),
    ...(set
      ? {
          use: {
            set: set.name,
            ...(set.useName ? { name: set.useName } : {}),
            child: set.child,
            of: set.of
          }
        }
      : {})
  })
  // The use step's own checks look at the step marked `useTests`, else the set's last.
  const marked = set ? set.doc.steps.findIndex((s) => s.useTests === true) : -1
  const useChecksThis = set ? set.child === (marked >= 0 ? marked : set.of - 1) : false
  const layers: Layer[] = requestLayers({
    endpoint,
    base,
    collection: input.collection,
    set: set?.doc,
    step
  }).map(({ kind, ...parts }) => ({ ...ROLES[kind], ...parts }))
  if (useChecksThis && set?.useTests)
    layers.push({ script: 'use', label: 'use', tests: set.useTests })
  // What the request is built from: every layer's headers and settings.
  const collection = folded(layers, input.collection)
  const failed = (error: RunError) => ({
    ...failedBeforeSending(step, collection, item, error, startedHr, logs),
    ...withLogs()
  })

  let run: VariableScope
  /** The params, once known: a set's only from its own layer on (below). */
  let params: Record<string, VarValue> | undefined
  try {
    run = provided ?? (context ? await buildScope(context) : new VariableScope())
    // A set opened and run on its own takes its params' defaults.
    if (!set)
      params =
        input.params ??
        (input.collection?.params ? resolveParams(input.collection.params, {}, run) : undefined)
  } catch (cause) {
    return failed(interpolateError(cause))
  }
  /** What names resolve against: the run's, the params once known, and the forEach item. */
  const scopeOf = (known: Record<string, VarValue> | undefined): VariableScope => {
    const own = known ? new ParamsScope(run, known) : run
    return each ? new OverlayScope(own, new Map([['item', itemText(each.value)]]), 'forEach') : own
  }
  let scope = scopeOf(params)
  // A set's params are its own: the layers outside it — endpoint, base and the
  // caller's collection — run before they resolve, and never see them.
  const opens = set ? layers.findIndex((layer) => layer.script === 'set') : 0
  /** What every script gets besides `gta`, `req` and `res`. */
  const shared = (adopt: Adopt, index: number) => ({
    assert,
    ...(params && index >= opens ? { params: adopt(params) } : {}),
    ...(each ? { item: adopt(each.value) } : {}),
    ...(endpoint ? { endpoint: adopt(endpointValues(endpoint, step, scope)) } : {})
  })
  const filenameOf = (layer: Layer, kind: 'before.script' | 'tests') =>
    layer.label === '' ? kind : `${layer.label} ${kind}`

  /** The request as written, with what the scripts changed of its body and headers. */
  let edited: SentRequest | null = null
  // Outermost first, so each may build on what came before.
  for (const [index, layer] of layers.entries()) {
    // A use's with: resolves here, so it reads what the caller's scripts just set.
    if (set && index === opens) {
      try {
        params = set.params()
      } catch (cause) {
        return failed({ phase: 'use', message: (cause as Error).message })
      }
      scope = scopeOf(params)
    }
    const before = layer.before
    const script = layer.script
    if (before?.script) {
      const shown: SentRequest = reading?.request ?? edited ?? toSentRequestSafely(step, collection)
      let view: RequestView | undefined
      const error = await runScript(before.script, {
        phase: 'pre-request',
        filename: filenameOf(layer, 'before.script'),
        logs,
        ...(checks ? { checks } : {}),
        globals: (adopt) => {
          view = requestView(shown, adopt)
          return { ...shared(adopt, index), gta: preRequestGta(scope, control), req: view }
        }
      })
      if (error) return failed({ ...error, script })
      try {
        // A step reading a connection sends nothing, so there is nothing to change.
        if (!reading) edited = changedRequest(shown, view, step.body) ?? edited
      } catch (cause) {
        return failed({ phase: 'pre-request', message: (cause as Error).message, script })
      }
      // `gta.skip`: nothing is sent, and no later script runs.
      if (control.skip !== null) {
        return {
          item,
          request: reading?.request ?? edited ?? toSentRequestSafely(step, collection),
          response: null,
          assertions: [],
          ...withLogs(),
          error: null,
          status: 'skipped',
          skipped: { reason: control.skip },
          durationMs: performance.now() - startedHr
        }
      }
    }
  }

  const settings = resolveSettings(collection?.settings, step.settings)
  /** Build the request, then send it: what goes wrong building it is the step's result. */
  const send = async (): Promise<SendOutcome | RunResult> => {
    let spec: SentRequest
    let payload: Uint8Array | null
    try {
      const prepared = await prepareRequest(
        edited ?? toSentRequest(step, collection),
        step.body,
        scope,
        await fileRoots(
          step,
          set?.path ?? context?.collectionPath ?? itemPath,
          context?.collectionPath ?? itemPath
        )
      )
      spec = prepared.request
      payload = prepared.payload
    } catch (cause) {
      if (cause instanceof BodyFileError) return failed({ phase: 'body', message: cause.message })
      return failed(interpolateError(cause))
    }
    // A step opening a connection replaces one of the same name, whatever comes back.
    const opens = step.connection
    if (opens !== undefined) input.connections?.close(opens)
    return sendHttpRequest(spec, {
      settings,
      payload,
      ...(signal ? { signal } : {}),
      ...(tls && tls.ca.length > 0 ? { ca: tls.ca } : {}),
      ...(input.watch ? { watch: input.watch } : {}),
      ...(opens !== undefined
        ? {
            keep: (stream: OpenStream) => {
              if (input.connections) input.connections.open(opens, stream)
              else stream.close()
            }
          }
        : {})
    })
  }
  const outcome = reading
    ? await readConnection(reading, {
        settings,
        ...(signal ? { signal } : {}),
        ...(input.watch ? { watch: input.watch } : {})
      })
    : await send()

  if (!('ok' in outcome)) return outcome
  if (!outcome.ok) {
    const error: RunError = {
      phase: 'http',
      message: outcome.error.message,
      ...(outcome.error.code ? { code: outcome.error.code } : {})
    }
    return {
      item,
      request: outcome.request,
      response: null,
      assertions: [],
      ...withLogs(),
      error,
      status: 'error',
      durationMs: performance.now() - startedHr
    }
  }

  const response = withConnection(outcome.response, step, input.connections)
  const session = new CheckSession({ response, scope })
  let testsError: RunError | null = null
  try {
    for (const [index, layer] of layers.entries()) {
      const code = layer.tests
      if (!code || testsError) continue
      const pending: Promise<unknown>[] = []
      const filename = filenameOf(layer, 'tests')
      const run = () =>
        session.madeBy(
          layer.script,
          filename,
          () =>
            runScript(code, {
              phase: 'tests',
              filename,
              logs,
              ...(checks ? { checks } : {}),
              pending: () => pending,
              globals: (adopt) => ({
                ...shared(adopt, index),
                gta: testsGta({
                  session,
                  scope,
                  pending,
                  control,
                  warn: (message) => logs.push({ level: 'warn', phase: 'tests', message })
                }),
                req: requestView(outcome.request, adopt),
                res: responseView(response, adopt)
              })
            }),
          (checks ?? []).map((file) => file.filename)
        )
      // An endpoint base's checks are defaults: the step's own replace them.
      const scriptError = layer.defaults ? await session.asDefaults(run) : await run()
      if (scriptError) testsError = { ...scriptError, script: layer.script }
    }
  } catch (cause) {
    // A bug in evaluation is reported as one, never as a passing step.
    testsError = {
      phase: 'tests',
      message: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {})
    }
  }
  const checked = session.finish()

  return {
    item,
    request: outcome.request,
    response,
    assertions: checked.assertions,
    ...(checked.ignored ? { ignored: checked.ignored } : {}),
    ...(checked.sortedBy ? { sortedBy: checked.sortedBy } : {}),
    ...withLogs(),
    error: testsError,
    status: deriveStatus(checked.assertions, testsError, true),
    durationMs: performance.now() - startedHr
  }
}

/**
 * An event stream's response, saying which connection it opened or read and
 * whether that is still open (SPEC.md §2.11).
 */
function withConnection(
  response: ReceivedResponse,
  step: Step,
  connections: Connections | undefined
): ReceivedResponse {
  const name = step.connection
  if (name === undefined || !response.stream) return response
  const kept = connections?.get(name)
  return {
    ...response,
    stream: { ...response.stream, connection: { name, open: kept?.pump.end === null } }
  }
}

/** What a `before.script` sees of the request, and may change: `req`. */
type RequestView = { body?: unknown; headers?: unknown }

/**
 * What a `before.script` changed of the request it is about to send, which is
 * still as written, `{{variables}}` and all (SPEC.md §5): its body, when that
 * is text of the step's own, and its headers. Null when it changed neither.
 */
function changedRequest(
  shown: SentRequest,
  view: RequestView | undefined,
  body: Body | undefined
): SentRequest | null {
  if (!view) return null
  let next: SentRequest | null = null
  if (view.body !== shown.body) {
    if (typeof view.body !== 'string') {
      throw new Error(`req.body is the body's text; a script set it to ${typeof view.body}`)
    }
    const text = body?.json ?? body?.xml ?? body?.text ?? body?.graphql
    if (text === undefined) {
      throw new Error(
        'req.body can be changed for a json, xml, text or graphql body; a form, multipart or file body is built from its parts, and a step with no body has none to change'
      )
    }
    next = { ...shown, body: view.body }
  }
  const was = headerMap(shown.headers)
  if (JSON.stringify(view.headers) !== JSON.stringify(was)) {
    const headers = view.headers
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) {
      throw new Error('req.headers is a map of header names to their values')
    }
    next = {
      ...(next ?? shown),
      headers: Object.entries(headers)
        .filter(([, value]) => value !== undefined && value !== null)
        .flatMap(([name, value]) =>
          // Left as it read: sent as it was, a repeated header still once per value.
          value === was[name]
            ? shown.headers.filter((header) => header.name === name)
            : // An array: one header per value.
              Array.isArray(value)
              ? value.map((each) => ({ name, value: String(each) }))
              : [{ name, value: String(value) }]
        )
    }
  }
  return next
}

/**
 * Where the files a step's body names are read from (SPEC.md §2.2), for a
 * step in `file` — for one of a request set's steps, the set's, which may be a
 * global project's. Null for a request in no file, and for a body that names
 * no file, which needs none.
 */
async function fileRoots(
  step: Step,
  file: string | null | undefined,
  collection: string | null | undefined
): Promise<FileRoots | null> {
  if (!file || bodyFiles(step.body).length === 0) return null
  return fileRootsOf(file, collection ?? file)
}

/**
 * A missing or looping variable is reported as its own phase, because it never
 * reached the network and "connection refused" would be a lie.
 */
function interpolateError(cause: unknown): RunError {
  return {
    phase: 'interpolate',
    message: cause instanceof Error ? cause.message : String(cause),
    ...(cause instanceof InterpolationError && cause.variable ? { code: cause.variable } : {})
  }
}

function failedBeforeSending(
  step: Step,
  collection: Collection | undefined,
  item: RunResult['item'],
  error: RunError,
  startedHr: number,
  logs: LogEntry[]
): RunResult {
  return {
    item,
    request: toSentRequestSafely(step, collection),
    response: null,
    assertions: [],
    ...(logs.length > 0 ? { logs } : {}),
    error,
    status: 'error',
    durationMs: performance.now() - startedHr
  }
}

/** The uninterpolated call, so a failed run still shows what was attempted. */
function toSentRequestSafely(step: Step, collection?: Collection): SentRequest {
  if (isReadStep(step)) return { method: 'READ', url: step.connection, headers: [], body: null }
  try {
    return toSentRequest(step, collection)
  } catch {
    return { method: 'GET', url: '', headers: [], body: null }
  }
}
