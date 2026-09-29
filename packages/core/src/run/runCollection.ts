import path from 'node:path'
import {
  isUseStep,
  readRequestLine,
  stepLabel,
  type Collection,
  type Step,
  type VarValue
} from '../model/documents.js'
import { checkFlags, UnknownFlagError } from '../flags/flags.js'
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
   * `index` is the collection step it belongs to — for a use step, each of its
   * set's requests reports under it, with `result.use` saying which.
   */
  onResult?: (index: number, result: RunResult) => void
  /**
   * Stop at the first failure.
   *
   * Off by default: a suite is more useful when it reports everything that is
   * wrong, not just the first thing.
   */
  bail?: boolean
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
  const startedHr = performance.now()

  // The collection as given says what it extends, saved or not.
  const scope = context
    ? await buildScope({ collectionExtends: collection.extends ?? null, ...context })
    : new VariableScope()
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
  // A collection that is itself a request set runs on its params' defaults.
  const own = collection.params ? selfAsSet(collection, collectionPath) : undefined
  const plan = await planSteps(collection, collectionPath)
  const results: RunResult[] = []
  /** Params of the use running now, resolved when its first step starts. */
  let params: Record<string, VarValue> = {}

  for (const planned of plan) {
    if (signal?.aborted) break

    let result: RunResult
    if (baseError) {
      result = brokenUse(planned.step, baseError, collectionPath)
    } else if (planned.kind === 'broken') {
      result = brokenUse(planned.step, planned.error, collectionPath)
    } else {
      const set = planned.set ? positionOf(planned.set, planned.child ?? 0) : undefined
      if (set || own) {
        const starting = set ? set.child === 0 : planned.index === 0
        if (starting) {
          try {
            params = resolveParams(set?.planned ?? own!, scope)
          } catch (cause) {
            params = {}
            result = brokenUse(
              planned.step,
              {
                phase: 'use',
                message: `use: ${(set?.planned ?? own!).name} — ${(cause as Error).message}`
              },
              collectionPath
            )
            results.push(result)
            onResult?.(planned.index, result)
            if (bail) break
            continue
          }
        }
      }
      const gate = flagGate(collection, planned.index, planned.step, scope)
      if (gate) {
        result = gate(collectionPath)
        results.push(result)
        onResult?.(planned.index, result)
        if (bail && result.status === 'error') break
        continue
      }
      result = await runRequest({
        step: planned.step,
        collection,
        itemPath: collectionPath,
        scope,
        checks,
        endpoints,
        base,
        ...(library ? { tls: library.tls } : {}),
        ...(set
          ? {
              set: {
                name: set.planned.name,
                path: set.planned.path,
                doc: set.planned.doc,
                params,
                child: set.child,
                of: set.of,
                useTests: set.planned.useTests
              }
            }
          : own
            ? { params }
            : {}),
        ...(signal ? { signal } : {})
      })
    }
    results.push(result)
    onResult?.(planned.index, result)

    if (bail && result.status !== 'pass') break
  }

  return {
    total: plan.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    errored: results.filter((r) => r.status === 'error').length,
    // A step a feature flag skipped, and one never attempted, are both not run.
    skipped: plan.length - results.length + results.filter((r) => r.status === 'skipped').length,
    durationMs: performance.now() - startedHr,
    results
  }
}

/**
 * A use step's set and position, for a planned step that came from one, as
 * the runner needs it.
 */
function positionOf(planned: PlannedSet, child: number) {
  return { planned, child, of: planned.doc.steps.length }
}

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
