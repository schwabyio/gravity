import assert from 'node:assert/strict'
import path from 'node:path'
import { CheckSession } from '../assert/session.js'
import { sendHttpRequest } from '../http/client.js'
import type { Collection, Step, VarValue } from '../model/documents.js'
import {
  isUseStep,
  mergeHeaders,
  readRequestLine,
  stepLabel,
  type Before,
  type Headers,
  type Settings
} from '../model/documents.js'
import {
  deriveStatus,
  type LogEntry,
  type RunError,
  type RunResult,
  type SentRequest
} from '../model/run.js'
import {
  newStepControl,
  preRequestGta,
  requestView,
  responseView,
  testsGta,
  type StepControl
} from '../runtime/gta.js'
import { runScript, type Adopt } from '../runtime/sandbox.js'
import { loadLibrary, type CheckFile, type EndpointBase } from '../workspace/library.js'
import { projectRootOf } from '../workspace/project.js'
import type { ProjectTrust } from '../workspace/projectTls.js'
import { findEndpoint, placeholdersOf } from '../model/endpoints.js'
import { buildScope, type ScopeContext } from '../vars/resolve.js'
import { InterpolationError, OverlayScope, ParamsScope, VariableScope } from '../vars/scope.js'
import { interpolateToString } from '../vars/interpolate.js'
import { resolveSettings, toSentRequest } from './buildRequest.js'
import { resolveParams } from './plan.js'
import { BodyFileError, prepareRequest } from './prepareRequest.js'

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
  /** Its params, resolved: `params.<name>` in scripts, `{{params.<name>}}` in requests. */
  params: Record<string, VarValue>
  /** Which of its steps this is, 0-based, and how many it has. */
  child: number
  of: number
  /** The use step's own `tests`, run after the set's last step. */
  useTests?: string | undefined
}

/**
 * What a step is sent with: every layer's headers and settings folded, the
 * outermost first, so each nearer one wins; the step's own go on top when the
 * request is built.
 */
function folded(layers: Layer[], collection: Collection | undefined): Collection {
  let headers: Headers | undefined
  let settings: Settings = {}
  for (const layer of layers) {
    if (layer.script === 'step' || layer.script === 'use') continue
    if (layer.headers) headers = mergeHeaders(headers, layer.headers)
    settings = { ...settings, ...layer.settings }
  }
  return {
    ...collection,
    steps: [],
    ...(headers ? { headers } : {}),
    ...(Object.keys(settings).length > 0 ? { settings } : {})
  }
}

/** The parts of a document a layer takes. */
const partsOf = (
  doc: Pick<Collection, 'headers' | 'settings' | 'before' | 'tests'> | undefined
) => ({
  headers: doc?.headers,
  settings: doc?.settings,
  before: doc?.before,
  tests: doc?.tests
})

/** Whether the run has to read the project for checks, endpoints, a base or `tls`. */
const needsLibrary = (input: RunStepInput) =>
  input.checks === undefined ||
  input.endpoints === undefined ||
  input.tls === undefined ||
  (input.base === undefined && input.collection?.extends !== undefined)

/** The endpoint base a step's request is for, if any. */
function endpointFor(step: Step, endpoints: EndpointBase[]): EndpointBase | null {
  if (isUseStep(step) || endpoints.length === 0) return null
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
  // A tls.ca file that cannot be read: send nothing, rather than fail later with a vaguer TLS error.
  if (tls && tls.problems.length > 0) {
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
  const last = set ? set.child === set.of - 1 : false
  const layers: Layer[] = []
  if (endpoint) {
    layers.push({
      script: 'endpoint',
      label: 'endpoint file',
      defaults: true,
      ...partsOf(endpoint.file)
    })
    layers.push({
      script: 'endpoint',
      label: 'endpoint',
      defaults: true,
      ...partsOf(endpoint.step)
    })
  }
  if (base) layers.push({ script: 'base', label: 'base', ...partsOf(base) })
  layers.push({ script: 'collection', label: 'collection', ...partsOf(input.collection) })
  if (set) layers.push({ script: 'set', label: 'set', ...partsOf(set.doc) })
  layers.push({ script: 'step', label: '', before: step.before, tests: step.tests })
  // The use step's own checks come after the whole set has run.
  if (last && set?.useTests) layers.push({ script: 'use', label: 'use', tests: set.useTests })
  // What the request is built from: every layer's headers and settings.
  const collection = folded(layers, input.collection)
  const failed = (error: RunError) => ({
    ...failedBeforeSending(step, collection, item, error, startedHr, logs),
    ...withLogs()
  })

  let spec: SentRequest
  let scope: VariableScope
  let params: Record<string, VarValue> | undefined
  try {
    const run = provided ?? (context ? await buildScope(context) : new VariableScope())
    // A set opened and run on its own takes its params' defaults.
    params =
      set?.params ??
      input.params ??
      (input.collection?.params ? resolveParams(input.collection.params, {}, run) : undefined)
    const own = params ? new ParamsScope(run, params) : run
    scope = each ? new OverlayScope(own, new Map([['item', itemText(each.value)]]), 'forEach') : own
  } catch (cause) {
    return failed(interpolateError(cause))
  }
  /** What every script gets besides `gta`, `req` and `res`. */
  const shared = (adopt: Adopt) => ({
    assert,
    ...(params ? { params: adopt(params) } : {}),
    ...(each ? { item: adopt(each.value) } : {}),
    ...(endpoint ? { endpoint: adopt(endpointValues(endpoint, step, scope)) } : {})
  })
  const filenameOf = (layer: Layer, kind: 'before.script' | 'tests') =>
    layer.label === '' ? kind : `${layer.label} ${kind}`

  // Outermost first, so each may build on what came before.
  for (const layer of layers) {
    const before = layer.before
    const script = layer.script
    if (before?.script) {
      const error = await runScript(before.script, {
        phase: 'pre-request',
        filename: filenameOf(layer, 'before.script'),
        logs,
        ...(checks ? { checks } : {}),
        globals: (adopt) => ({
          ...shared(adopt),
          gta: preRequestGta(scope, control),
          req: requestView(toSentRequestSafely(step, collection), adopt)
        })
      })
      if (error) return failed({ ...error, script })
      // `gta.skip`: nothing is sent, and no later script runs.
      if (control.skip !== null) {
        return {
          item,
          request: toSentRequestSafely(step, collection),
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

  let payload: Uint8Array | null
  try {
    const prepared = await prepareRequest(
      toSentRequest(step, collection),
      step.body,
      scope,
      filesRoot(set?.path ?? context?.collectionPath ?? itemPath)
    )
    spec = prepared.request
    payload = prepared.payload
  } catch (cause) {
    if (cause instanceof BodyFileError) return failed({ phase: 'body', message: cause.message })
    return failed(interpolateError(cause))
  }

  const settings = resolveSettings(collection?.settings, step.settings)
  const outcome = await sendHttpRequest(spec, {
    settings,
    payload,
    ...(signal ? { signal } : {}),
    ...(tls && tls.ca.length > 0 ? { ca: tls.ca } : {})
  })

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

  const response = outcome.response
  const session = new CheckSession({ response, scope })
  let testsError: RunError | null = null
  try {
    for (const layer of layers) {
      const code = layer.tests
      if (!code || testsError) continue
      const pending: Promise<unknown>[] = []
      const run = () =>
        runScript(code, {
          phase: 'tests',
          filename: filenameOf(layer, 'tests'),
          logs,
          ...(checks ? { checks } : {}),
          pending: () => pending,
          globals: (adopt) => ({
            ...shared(adopt),
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
        })
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
    ...(checked.sortedBy ? { sortedBy: checked.sortedBy } : {}),
    ...withLogs(),
    error: testsError,
    status: deriveStatus(checked.assertions, testsError, true),
    durationMs: performance.now() - startedHr
  }
}

/**
 * The folder the files a step's body names are read from: that of the project
 * its file is in — for one of a request set's steps, the set's file, which may
 * be a global project's. Null for a request in no file.
 */
function filesRoot(file: string | null | undefined): string | null {
  return file ? (projectRootOf(file) ?? path.dirname(file)) : null
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
  try {
    return toSentRequest(step, collection)
  } catch {
    return { method: 'GET', url: '', headers: [], body: null }
  }
}
