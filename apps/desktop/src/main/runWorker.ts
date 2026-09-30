/**
 * Utility-process entry point.
 *
 * Everything that executes a request happens here: the HTTP call, and the
 * user's `before.script` and `tests` code in the sandbox. Keeping it out of the main
 * process means a script that loops forever or calls `process.exit()` costs a
 * worker, not the window, and Cancel can be a real kill.
 */
import {
  checkFlags,
  isUseStep,
  readRequestLine,
  stepLabel,
  UnknownFlagError,
  runRequest,
  runSuite,
  type Collection,
  type RunResult,
  type Step,
  CollectionSchema,
  EnvironmentDocSchema,
  StepSchema,
  VarsSchema
} from '@schwabyio/gravity-core'

interface RunStepMessage {
  type: 'run'
  runId: string
  step: unknown
  collection: unknown
  /** Collection file to resolve variables from; null for the scratchpad. */
  collectionPath: string | null
  environment?: string | null
  environmentOverrides?: Array<{ path: string; doc: unknown }>
  projectVars?: unknown
  flags?: Record<string, string | number | boolean> | null
  dataRow?: DataRow | null
}

/** A data file row as main checked it (SPEC.md §2.8). */
interface DataRow {
  source: string
  vars: Record<string, string | number | boolean | null>
  label?: string | null
}

interface RunCollectionMessage {
  type: 'runCollection'
  runId: string
  collection: unknown
  collectionPath: string | null
  environment?: string | null
  environmentOverrides?: Array<{ path: string; doc: unknown }>
  projectVars?: unknown
  flags?: Record<string, string | number | boolean> | null
  dataRow?: DataRow | null
  /** Every row: the collection runs once per row, each with a fresh scope. */
  dataRows?: DataRow[]
}

interface CancelMessage {
  type: 'cancel'
  runId: string
}

type Incoming = RunStepMessage | RunCollectionMessage | CancelMessage

const inFlight = new Map<string, AbortController>()

process.parentPort.on('message', (event) => {
  const message = event.data as Incoming
  if (message.type === 'cancel') {
    inFlight.get(message.runId)?.abort()
    return
  }
  if (message.type === 'run') void handleStep(message)
  if (message.type === 'runCollection') void handleCollection(message)
})

/**
 * Variables are resolved here, in the worker, because it is the process with
 * filesystem access and the one that runs user scripts. The collection sent
 * with a run is the one in the editor, so its variables — saved or not — are
 * the ones used, as its headers and scripts are.
 */
const contextFor = (message: {
  collectionPath: string | null
  environment?: string | null
  environmentOverrides?: Array<{ path: string; doc: unknown }>
  projectVars?: unknown
  flags?: Record<string, string | number | boolean> | null
  dataRow?: DataRow | null
  collection: unknown
}) => {
  if (!message.collectionPath) return {}
  const collection = message.collection ? CollectionSchema.parse(message.collection) : null
  return {
    context: {
      collectionPath: message.collectionPath,
      environmentName: message.environment ?? null,
      // Resolved by main — command output and overrides included — so scripts' gta.flag agrees.
      ...(message.flags !== undefined ? { flags: message.flags } : {}),
      // The row chosen in the app, as edited; absent, core reads the file's first.
      ...(message.dataRow !== undefined
        ? {
            dataRow: message.dataRow
              ? { source: message.dataRow.source, vars: message.dataRow.vars }
              : null
          }
        : {}),
      ...(collection
        ? { collectionVars: collection.vars ?? null, collectionExtends: collection.extends ?? null }
        : {}),
      ...(message.projectVars !== undefined
        ? {
            projectVars: message.projectVars === null ? null : VarsSchema.parse(message.projectVars)
          }
        : {}),
      // Environment files with unsaved edits: those, not the files.
      environments: (message.environmentOverrides ?? []).map((override) => ({
        path: override.path,
        doc: EnvironmentDocSchema.parse(override.doc)
      }))
    }
  }
}

async function handleStep(message: RunStepMessage): Promise<void> {
  const controller = new AbortController()
  inFlight.set(message.runId, controller)
  try {
    const step = StepSchema.parse(message.step)
    const collection = message.collection ? CollectionSchema.parse(message.collection) : null
    // A step run on its own honours feature flags as a collection run does.
    const gate = flagGate(collection, step, message.flags ?? null, message.collectionPath)
    if (gate) {
      process.parentPort.postMessage({ type: 'result', runId: message.runId, result: gate })
      return
    }
    const result = await runRequest({
      step,
      ...(collection ? { collection } : {}),
      itemPath: message.collectionPath,
      signal: controller.signal,
      ...contextFor(message)
    })
    process.parentPort.postMessage({ type: 'result', runId: message.runId, result })
  } catch (cause) {
    postFailure(message.runId, cause)
  } finally {
    inFlight.delete(message.runId)
  }
}

async function handleCollection(message: RunCollectionMessage): Promise<void> {
  const controller = new AbortController()
  inFlight.set(message.runId, controller)
  try {
    const collection = CollectionSchema.parse(message.collection)
    // As gta runs it (SPEC.md §2.8, §2.10): setup once, then with a data file
    // once per row — each row a fresh scope, rows in order — then teardown.
    // Cancel stops where it is.
    const summary = await runSuite({
      collection,
      collectionPath: message.collectionPath,
      signal: controller.signal,
      rows: message.dataRows?.length
        ? message.dataRows.map((row) => ({
            source: row.source,
            vars: row.vars,
            label: row.label ?? null
          }))
        : null,
      // Report each step as it lands so the list fills in during the run;
      // `result.stage` says when it is a setup or teardown step.
      onResult: (index, result, iteration) =>
        process.parentPort.postMessage({
          type: 'progress',
          runId: message.runId,
          index,
          result,
          ...(iteration ? { iteration } : {})
        }),
      ...contextFor(message)
    })
    process.parentPort.postMessage({ type: 'summary', runId: message.runId, summary })
  } catch (cause) {
    postFailure(message.runId, cause)
  } finally {
    inFlight.delete(message.runId)
  }
}

const postFailure = (runId: string, cause: unknown) =>
  process.parentPort.postMessage({
    type: 'failure',
    runId,
    message: cause instanceof Error ? cause.message : String(cause)
  })

/**
 * Whether a step's feature flags — the collection's and its own — let it run
 * (SPEC.md §2.9). Null when it runs; otherwise the result to report instead:
 * skipped with the reason, or an error for a flag nobody declared.
 */
function flagGate(
  collection: Collection | null,
  step: Step,
  flags: Record<string, string | number | boolean> | null,
  collectionPath: string | null
): RunResult | null {
  const notRun = (): RunResult => ({
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
  try {
    for (const conditions of [collection?.flags, step.flags]) {
      const check = checkFlags(conditions, flags)
      if (!check.run) return { ...notRun(), skipped: { reason: check.reason } }
    }
    return null
  } catch (cause) {
    if (!(cause instanceof UnknownFlagError)) throw cause
    return { ...notRun(), status: 'error', error: { phase: 'flags', message: cause.message } }
  }
}
