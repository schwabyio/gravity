import type { Collection, VarValue } from '../model/documents.js'
import type { CollectionRunSummary, RunResult } from '../model/run.js'
import type { ScopeContext } from '../vars/resolve.js'
import type { StreamWatch } from '../http/stream.js'
import { Connections } from './connections.js'
import { planSteps } from './plan.js'
import { runCollection } from './runCollection.js'

/** One row of a collection's data file, as a run takes it (SPEC.md §2.8). */
export interface SuiteRow {
  /** Where its values come from, for diagnostics: `users.csv row 2`. */
  source: string
  vars: Record<string, VarValue>
  /** Its `iterationLabel`, when it has one. */
  label: string | null
}

/** Which row of a data file a result ran with, from 1. */
export interface SuiteIteration {
  index: number
  of: number
  label: string | null
}

export interface SuiteRunOptions {
  collection: Collection
  /** Identity for reports; null for an unsaved collection. */
  collectionPath?: string | null
  /**
   * Where variables come from; each row adds its own. Without `rows`, its
   * `dataRow` is what the steps run with, as for `runCollection`.
   */
  context?: ScopeContext
  /** The data file's rows: `steps` run once for each, in order. Absent or empty: once. */
  rows?: SuiteRow[] | null
  signal?: AbortSignal
  /** Stop at the first failure: the rest of setup, or of the rows, is not run. */
  bail?: boolean
  /**
   * As each request finishes: the step it belongs to in its own list
   * (`result.stage` says which list), and the data row it ran with, if any.
   */
  onResult?: (index: number, result: RunResult, iteration: SuiteIteration | undefined) => void
  /**
   * The connections steps open and read (SPEC.md §2.11), when the caller keeps
   * them past the run, as the app does between Sends. Absent, the run has its
   * own, closed when it ends.
   */
  connections?: Connections
  /** For an event stream: the app's live view of its events, and its Stop button. */
  watch?: StreamWatch
}

/**
 * Run a collection the way gta and the app's Run all do (SPEC.md §2.8, §2.10):
 * `setup` once, `steps` once for each data row (or once without a data file),
 * then `teardown` once.
 *
 * Every value setup sets lasts the run, and so does one a row sets with
 * `gta.set(…, { scope: 'run' })`; anything else a row sets lasts only that
 * row. A setup step that fails stops the rows, and a bail stops the rows still
 * to come; teardown runs after either, every step of it, since it is the
 * cleanup. A cancelled run stops where it is, teardown included.
 */
export async function runSuite(options: SuiteRunOptions): Promise<CollectionRunSummary> {
  const connections = options.connections ?? new Connections()
  try {
    return await runStages(options, connections)
  } finally {
    // A connection lasts the run: setup's are read by every row, a row's by its later steps.
    if (!options.connections) connections.close()
  }
}

async function runStages(
  options: SuiteRunOptions,
  connections: Connections
): Promise<CollectionRunSummary> {
  const { collection, collectionPath = null, context, signal, bail = false, onResult } = options
  const shared = { connections, ...(options.watch ? { watch: options.watch } : {}) }
  const values = new Map<string, VarValue>()
  const summaries: CollectionRunSummary[] = []
  /** Setup and teardown run with no data row, and everything they set lasts. */
  const once = (stage: 'setup' | 'teardown', stopEarly: boolean) =>
    runCollection({
      collection,
      collectionPath,
      stage,
      run: { values, wide: true },
      ...shared,
      ...(context ? { context: { ...context, dataRow: null } } : {}),
      ...(signal ? { signal } : {}),
      bail: stopEarly,
      onResult: (index, result) => onResult?.(index, result, undefined)
    })

  let stopped = false
  if (collection.setup?.length) {
    const setup = await once('setup', bail)
    summaries.push(setup)
    stopped = setup.failed + setup.errored > 0
  }

  const rows = options.rows?.length ? options.rows : null
  const passes: Array<SuiteRow | null> = rows ?? [null]
  /** Steps of rows never begun, which count as not run. */
  let unrun = 0
  for (const [i, row] of passes.entries()) {
    if (stopped || signal?.aborted) {
      unrun = (await planSteps(collection, collectionPath)).length * (passes.length - i)
      break
    }
    const iteration = rows && row ? { index: i + 1, of: rows.length, label: row.label } : undefined
    const summary = await runCollection({
      collection,
      collectionPath,
      run: { values },
      ...shared,
      ...(context
        ? {
            context: row ? { ...context, dataRow: { source: row.source, vars: row.vars } } : context
          }
        : {}),
      ...(signal ? { signal } : {}),
      bail,
      onResult: (index, result) => onResult?.(index, result, iteration)
    })
    summaries.push(summary)
    // Bail stops the collection, every row still to come included.
    if (bail && summary.failed + summary.errored > 0) stopped = true
  }

  if (collection.teardown?.length && !signal?.aborted) summaries.push(await once('teardown', false))

  return {
    total: summaries.reduce((n, s) => n + s.total, 0) + unrun,
    passed: summaries.reduce((n, s) => n + s.passed, 0),
    failed: summaries.reduce((n, s) => n + s.failed, 0),
    errored: summaries.reduce((n, s) => n + s.errored, 0),
    skipped: summaries.reduce((n, s) => n + s.skipped, 0) + unrun,
    durationMs: summaries.reduce((n, s) => n + s.durationMs, 0),
    results: summaries.flatMap((s) => s.results)
  }
}
