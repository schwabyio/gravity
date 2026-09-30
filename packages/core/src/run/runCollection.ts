import path from 'node:path'
import {
  isUseStep,
  readRequestLine,
  stepLabel,
  type Collection,
  type Stage,
  type Step,
  type VarValue
} from '../model/documents.js'
import { show } from '../assert/evaluate.js'
import { checkFlags, UnknownFlagError } from '../flags/flags.js'
import { newStepControl } from '../runtime/gta.js'
import { interpolate } from '../vars/interpolate.js'
import type { CollectionRunSummary, RunError, RunResult } from '../model/run.js'
import { loadLibrary } from '../workspace/library.js'
import { planSteps, resolveParams, type PlannedSet } from './plan.js'
import { buildScope, type ScopeContext } from '../vars/resolve.js'
import { VariableScope } from '../vars/scope.js'
import { runRequest } from './runRequest.js'

export interface CollectionRunOptions {
  collection: Collection
  /** Identity for reports; null for an unsaved collection. */
  collectionPath?: string | null
  /** Where to resolve variables from. Omit when there is no collection on disk. */
  context?: ScopeContext
  signal?: AbortSignal
  /**
   * Called as each request finishes, so a UI can fill in results as they land.
   * `index` is the step it belongs to in the list being run — for a use step,
   * each of its set's requests reports under it, with `result.use` saying
   * which, and a `forEach` step reports once per item.
   */
  onResult?: (index: number, result: RunResult) => void
  /**
   * Stop at the first failure.
   *
   * Off by default: a suite is more useful when it reports everything that is
   * wrong, not just the first thing.
   */
  bail?: boolean
  /**
   * Which of the collection's lists to run: `steps`, the default, or `setup`
   * or `teardown` (SPEC.md §2.10), whose results say so.
   */
  stage?: 'steps' | Stage
  /** What lasts the whole collection run, across data rows (`ScopeContext.run`). */
  run?: ScopeContext['run']
}

/**
 * Run every step in a collection, in list order.
 *
 * **One variable scope is shared across the whole run.** That is the invariant
 * that makes a suite a suite: a value a step captures, or sets with `gta.set`,
 * is visible to the steps after it. Running a step on its own builds a fresh
 * scope instead, so it never depends on something an earlier step left behind
 * without saying so.
 */
export async function runCollection(options: CollectionRunOptions): Promise<CollectionRunSummary> {
  const { collection, collectionPath = null, context, signal, onResult, bail = false } = options
  const stage = options.stage ?? 'steps'
  const startedHr = performance.now()

  // The collection as given says what it extends, saved or not.
  const scope = context
    ? await buildScope({
        collectionExtends: collection.extends ?? null,
        ...context,
        ...(options.run ? { run: options.run } : {})
      })
    : withRun(new VariableScope(), options.run)
  const library = collectionPath ? await loadLibrary(collectionPath) : null
  const checks = library?.checks ?? []
  const endpoints = library?.endpoints ?? []
  // The base collection, once for the run; one that cannot be used stops every step.
  let base: Collection | null = null
  let baseError: RunError | null = null
  if (collection.extends) {
    try {
      if (!library)
        throw new Error(`extends: ${collection.extends} — save the collection in a project first`)
      base = await library.base(collection.extends)
    } catch (cause) {
      baseError = { phase: 'use', message: (cause as Error).message }
    }
  }
  // The list being run, as the collection's steps: its layers apply to all three.
  const running = stage === 'steps' ? collection : { ...collection, steps: collection[stage] ?? [] }
  // A collection that is itself a request set runs on its params' defaults.
  const own = collection.params ? selfAsSet(collection, collectionPath) : undefined
  const plan = await planSteps(running, collectionPath)
  const results: RunResult[] = []
  /**
   * Params of the use running now, once resolved: a use's when its first
   * request reaches the set's own layer, after the caller's `before.script`
   * (SPEC.md §2.5); a set run on its own's as its first step starts.
   */
  let params: Record<string, VarValue> | null = null
  /** Why the use running now could not start: each of its steps after that reports it. */
  let unstarted: RunError | null = null
  /** The params of `using`, resolved the first time they are asked for. */
  const paramsOf = (using: PlannedSet) => (): Record<string, VarValue> => {
    if (unstarted) throw new Error(unstarted.message)
    if (!params) {
      try {
        params = resolveParams(using.doc.params, using.with, scope)
      } catch (cause) {
        unstarted = { phase: 'use', message: `use: ${using.name} — ${(cause as Error).message}` }
        throw new Error(unstarted.message)
      }
    }
    return params
  }
  /** Why the steps still to come are skipped: `gta.skipRest` in one before them. */
  let rest: string | null = null
  /** Planned steps begun, so those never begun count as not run. */
  let attempted = 0

  const emit = (index: number, result: RunResult) => {
    const marked = stage === 'steps' ? result : { ...result, stage }
    results.push(marked)
    onResult?.(index, marked)
  }
  const failing = (result: RunResult) => result.status === 'fail' || result.status === 'error'

  planning: for (const planned of plan) {
    if (signal?.aborted) break
    attempted++

    if (baseError) {
      emit(planned.index, brokenUse(planned.step, baseError, collectionPath))
      if (bail) break
      continue
    }
    if (planned.kind === 'broken') {
      emit(planned.index, brokenUse(planned.step, planned.error, collectionPath))
      if (bail) break
      continue
    }
    const set = planned.set ? positionOf(planned.set, planned.child ?? 0) : undefined
    const inSet = set ? { use: useOf(set) } : {}
    if (rest !== null) {
      emit(planned.index, { ...skipped(planned.step, rest, collectionPath), ...inSet })
      continue
    }
    if (set || own) {
      const using = set?.planned ?? own!
      const starting = set ? set.child === 0 : planned.index === 0
      if (starting) {
        params = null
        unstarted = null
        if (!set) {
          try {
            paramsOf(using)()
          } catch {
            // `unstarted` says why, below.
          }
        }
      }
    }
    const gate = flagGate(running, planned.index, planned.step, scope)
    if (gate) {
      const result = gate(collectionPath)
      emit(planned.index, result)
      if (bail && result.status === 'error') break
      continue
    }
    // After the flags: a use they skip is skipped, whatever its params.
    if (unstarted && (set || own)) {
      emit(planned.index, { ...brokenUse(planned.step, unstarted, collectionPath), ...inSet })
      if (bail) break
      continue
    }

    // Once, or once for each item of a forEach list, resolved now so earlier steps' values count.
    let items: Array<{ value: unknown } | null> = [null]
    if (planned.step.forEach !== undefined) {
      try {
        items = forEachItems(planned.step.forEach, scope).map((value) => ({ value }))
      } catch (cause) {
        const error: RunError = { phase: 'forEach', message: (cause as Error).message }
        emit(planned.index, { ...brokenUse(planned.step, error, collectionPath), ...inSet })
        if (bail) break
        continue
      }
      if (items.length === 0) {
        const reason = `forEach: ${planned.step.forEach} is an empty list`
        emit(planned.index, { ...skipped(planned.step, reason, collectionPath), ...inSet })
        continue
      }
    }
    for (const [index, each] of items.entries()) {
      if (signal?.aborted) break planning
      if (rest !== null) {
        emit(planned.index, { ...skipped(planned.step, rest, collectionPath), ...inSet })
        continue
      }
      const control = newStepControl()
      const result = await runRequest({
        step: planned.step,
        collection,
        itemPath: collectionPath,
        scope,
        checks,
        endpoints,
        base,
        control,
        ...(library ? { tls: library.tls } : {}),
        ...(each ? { item: { value: each.value, index, of: items.length } } : {}),
        ...(set
          ? {
              set: {
                name: set.planned.name,
                ...(set.planned.useName ? { useName: set.planned.useName } : {}),
                path: set.planned.path,
                doc: set.planned.doc,
                params: paramsOf(set.planned),
                child: set.child,
                of: set.of,
                useTests: set.planned.useTests
              }
            }
          : own
            ? { params: params ?? {} }
            : {}),
        ...(signal ? { signal } : {})
      })
      emit(planned.index, result)
      rest ??= control.rest
      if (bail && failing(result)) break planning
    }
  }

  const notBegun = plan.length - attempted
  return {
    total: results.length + notBegun,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    errored: results.filter((r) => r.status === 'error').length,
    // A step a feature flag or a script skipped, and one never begun, are all not run.
    skipped: notBegun + results.filter((r) => r.status === 'skipped').length,
    durationMs: performance.now() - startedHr,
    results
  }
}

/** A scope that keeps the run's lasting values, for a collection with no file to read. */
function withRun(scope: VariableScope, run: CollectionRunOptions['run']): VariableScope {
  if (!run) return scope
  const built = new VariableScope([{ source: 'run', vars: Object.fromEntries(run.values) }])
  built.runValues = run.values
  built.runWide = run.wide === true
  return built
}

/**
 * The items a step's `forEach` names (SPEC.md §2.1): its `{{variables}}`
 * resolved, then read as a JSON array — `["a", "b"]` written in place, or a
 * variable holding one, such as a list `gta.set` stored.
 */
export function forEachItems(expression: string, scope: VariableScope): unknown[] {
  const value = interpolate(expression, scope)
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not JSON: said below.
    }
  }
  throw new Error(
    `forEach: ${expression} is ${show(value)}, not a list; it needs a JSON array, such as ["a", "b"]`
  )
}

/**
 * A use step's set and position, for a planned step that came from one, as
 * the runner needs it.
 */
function positionOf(planned: PlannedSet, child: number) {
  return { planned, child, of: planned.doc.steps.length }
}

/** `RunResult.use` for one of a set's steps. */
const useOf = (set: ReturnType<typeof positionOf>): NonNullable<RunResult['use']> => ({
  set: set.planned.name,
  ...(set.planned.useName ? { name: set.planned.useName } : {}),
  child: set.child,
  of: set.of
})

/**
 * Run a request set on its own — opened and run like any collection — as if
 * a use step had run it with no values: its params take their defaults.
 */
function selfAsSet(collection: Collection, collectionPath: string | null): PlannedSet {
  return {
    name: collectionPath ? path.basename(collectionPath, '.yml') : (collection.id ?? 'set'),
    path: collectionPath ?? '',
    // Its own before, tests, headers and settings already apply as the collection's.
    doc: { params: collection.params, steps: collection.steps },
    useName: undefined,
    with: {},
    useTests: undefined
  }
}

/** A use step that could not run, reported as a result so the list shows why. */
function brokenUse(step: Step, error: RunError, collectionPath: string | null): RunResult {
  return {
    item: { path: collectionPath, name: stepLabel(step), seq: null },
    request: { method: 'GET', url: '', headers: [], body: null },
    response: null,
    assertions: [],
    error,
    status: 'error',
    durationMs: 0
  }
}

/**
 * Whether a step's feature flags let it run (SPEC.md §2.9): the collection's
 * conditions, the use step's when the step is one of a request set's, and the
 * step's own. Null when it runs; otherwise the result to report instead —
 * skipped with the reason, or an error for a flag the run does not know.
 */
function flagGate(
  collection: Collection,
  index: number,
  step: Step,
  scope: VariableScope
): ((collectionPath: string | null) => RunResult) | null {
  const owner = collection.steps[index]
  const layers = [collection.flags, owner !== step ? owner?.flags : undefined, step.flags]
  try {
    for (const conditions of layers) {
      const check = checkFlags(conditions, scope.flags)
      if (!check.run) {
        return (collectionPath) => ({
          ...notRun(step, collectionPath),
          status: 'skipped',
          skipped: { reason: check.reason }
        })
      }
    }
    return null
  } catch (cause) {
    if (!(cause instanceof UnknownFlagError)) throw cause
    return (collectionPath) =>
      brokenUse(step, { phase: 'flags', message: cause.message }, collectionPath)
  }
}

/** A step skipped for a reason: `gta.skipRest` before it, or an empty `forEach` list. */
const skipped = (step: Step, reason: string, collectionPath: string | null): RunResult => ({
  ...notRun(step, collectionPath),
  skipped: { reason }
})

/** A step that was not run, as a result: nothing sent, nothing received. */
const notRun = (step: Step, collectionPath: string | null): RunResult => ({
  item: { path: collectionPath, name: stepLabel(step), seq: null },
  request: {
    method: isUseStep(step) ? 'USE' : readRequestLine(step).method,
    url: '',
    headers: [],
    body: null
  },
  response: null,
  assertions: [],
  error: null,
  status: 'skipped',
  durationMs: 0
})
