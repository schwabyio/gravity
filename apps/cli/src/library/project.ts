import path from 'node:path'
import {
  canonical,
  COLLECTIONS_DIR,
  redact,
  resolveRequestSet,
  runSuite,
  secretValues,
  stepLabel,
  type Collection,
  type CollectionRunSummary as CoreRunSummary,
  type FlagValue as CoreFlagValue,
  type LoadedCollection,
  type RunResult as CoreRunResult,
  type VarValue as CoreVarValue
} from '@schwabyio/gravity-core'
import { runJob, stepLines, type JobOutcome } from '../job.js'
import { isDirectory, loadProject, type OpenProject } from '../project.js'
import { failureDetails, paint, tallyOf } from '../report.js'
import { findCollection, idOf } from '../select.js'
import type {
  CollectionRunSummary,
  FlagValue,
  GravityProject,
  OpenOptions,
  OpenProjectFunction,
  RunOptions,
  RunOutcome,
  RunResult,
  StepRef,
  UseOptions,
  VarValue
} from './types.js'

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
// types.ts writes the public types out; this stops compiling when they drift from the core's.
const sameAsCore: [
  Same<RunResult, CoreRunResult>,
  Same<CollectionRunSummary, CoreRunSummary>,
  Same<VarValue, CoreVarValue>,
  Same<FlagValue, CoreFlagValue>
] = [true, true, true, true]
void sameAsCore

/** The option each setting is given by, for messages: `the environment option`. */
const OPTION_OF: Record<string, string> = { environmentType: 'environment' }

/**
 * Where a use runs from: a collection in `collections/` holding the one use
 * step, so the project's variables, environment and flags apply, and nothing
 * else. Never read or written.
 */
const USE_FILE = '.gta-use.yml'

export const openProject: OpenProjectFunction = async (folder, options = {}) => {
  const root = await canonical(path.resolve(folder))
  if (!(await isDirectory(path.join(root, COLLECTIONS_DIR)))) {
    throw new Error(`${root} is not a Gravity project: it has no ${COLLECTIONS_DIR}/ folder.`)
  }
  const project = await loadProject({
    root,
    env: process.env,
    overrides: overridesOf(options),
    overrideLabel: (key) => `the ${OPTION_OF[key] ?? key} option`,
    flagValues: options.flags ?? {},
    optionalSettings: true
  })
  return projectOf(project)
}

function overridesOf(options: OpenOptions): Record<string, string> {
  return {
    ...(options.environment !== undefined ? { environmentType: options.environment } : {}),
    ...(options.bail !== undefined ? { bail: String(options.bail) } : {}),
    ...(options.timeoutCollection !== undefined
      ? { timeoutCollection: String(options.timeoutCollection) }
      : {})
  }
}

function projectOf(project: OpenProject): GravityProject {
  const { root, settings } = project
  const environment = settings.environmentType
  const flags = project.flags.values

  return {
    root,
    name: project.name,
    environment,
    environments: project.environments,
    flags,
    collections: project.collections.map(idOf),
    warnings: project.warnings,

    async run(name: string, options: RunOptions = {}): Promise<RunOutcome> {
      const collection = findCollection(project.collections, name)
      if (!collection) throw new Error(noSuchCollection(name, project))
      checkValues(options.vars, 'vars')
      // A file that will not load runs nothing: the job says why.
      const steps =
        options.steps && collection.problems.length === 0
          ? pickSteps(collection, options.steps)
          : null
      const { onResult } = options
      const file = collection.path
      const run = deadline(options.signal, settings.timeoutCollection)
      const produced = new Map<string, VarValue>()
      const started = performance.now()
      const outcome = await runJob(
        {
          file,
          projectRoot: root,
          environment,
          steps,
          bail: options.bail ?? settings.bail,
          flags,
          ...(options.vars ? { vars: options.vars } : {})
        },
        {
          signal: run.signal,
          produced,
          ...(onResult ? { onResult: (result, ref) => onResult(result, { file, ...ref }) } : {})
        }
      )
      return outcomeOf({
        id: idOf(collection),
        file,
        stepCount: steps?.length ?? collection.doc.steps.length,
        outcome,
        steps: outcome.ok ? outcome.steps.map((ref) => ({ file, ...ref })) : [],
        produced,
        stopped: run.stopped(),
        durationMs: performance.now() - started
      })
    },

    async use(
      set: string,
      params: Record<string, VarValue> = {},
      options: UseOptions = {}
    ): Promise<RunOutcome> {
      checkValues(params, 'params')
      checkValues(options.vars, 'vars')
      // Before anything runs: a set nothing answers to is a mistake in the test.
      const found = await resolveRequestSet(root, project.global, set)
      const collectionPath = path.join(root, COLLECTIONS_DIR, USE_FILE)
      const collection: Collection = { steps: [{ use: set, with: params }] }
      const context = {
        collectionPath,
        environmentName: environment,
        flags,
        dataRow: null,
        collectionVars: null
      }
      const secrets = await secretValues(context)
      const lines = (await stepLines(found.path)).steps
      // Each result is the set's, and says so.
      const shown = (result: CoreRunResult): RunResult => {
        const hidden = redact(result, secrets)
        return { ...hidden, item: { ...hidden.item, path: found.path } }
      }
      const steps: StepRef[] = []
      const run = deadline(options.signal, settings.timeoutCollection)
      const produced = new Map<string, VarValue>()
      const started = performance.now()
      let outcome: JobOutcome
      try {
        const summary = await runSuite({
          collection,
          collectionPath,
          context,
          bail: options.bail ?? settings.bail,
          signal: run.signal,
          produced,
          ...(options.vars ? { vars: options.vars } : {}),
          onResult: (_index, result) => {
            const child = result.use?.child ?? 0
            const ref: StepRef = { file: found.path, line: lines[child] ?? null, index: child }
            steps.push(ref)
            options.onResult?.(shown(result), ref)
          }
        })
        outcome = {
          ok: true,
          summary: { ...summary, results: summary.results.map(shown) },
          steps,
          data: null
        }
      } catch (cause) {
        outcome = { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
      }
      return outcomeOf({
        id: set,
        file: found.path,
        stepCount: found.doc.steps.length,
        outcome,
        steps,
        produced,
        stopped: run.stopped(),
        durationMs: performance.now() - started
      })
    }
  }
}

/** A signal for one run: the caller's, and `timeoutCollection`'s. */
function deadline(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return {
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    /** Why the run stopped before it finished, or null when nothing stopped it. */
    stopped: (): string | null =>
      timeout.aborted
        ? `Timed out after ${timeoutMs} ms (timeoutCollection)`
        : signal?.aborted
          ? 'The run was cancelled'
          : null
  }
}

function outcomeOf(run: {
  id: string
  file: string
  stepCount: number
  outcome: JobOutcome
  steps: StepRef[]
  produced: Map<string, VarValue>
  stopped: string | null
  durationMs: number
}): RunOutcome {
  const { outcome } = run
  const counted = tallyOf(run.id, run.stepCount, outcome, run.durationMs)
  // A run stopped part way fails, whatever its steps did, as gta reports one it timed out.
  const tally =
    run.stopped && outcome.ok ? { ...counted, passed: false, error: run.stopped } : counted
  return {
    passed: tally.passed,
    id: run.id,
    file: run.file,
    error: tally.error,
    summary: outcome.ok
      ? outcome.summary
      : {
          total: run.stepCount,
          passed: 0,
          failed: 0,
          errored: 0,
          skipped: run.stepCount,
          durationMs: run.durationMs,
          results: []
        },
    steps: run.steps,
    values: Object.fromEntries(run.produced),
    failures: tally.passed ? '' : failureDetails([tally], paint(false)).join('\n').trimEnd()
  }
}

/** The steps a run names, as places in `steps:` from 0, in the file's order. */
function pickSteps(collection: LoadedCollection, selectors: ReadonlyArray<string | number>) {
  const id = idOf(collection)
  const { steps } = collection.doc
  if (selectors.length === 0) {
    throw new Error(`steps is empty: name a step of ${id}, or leave steps out to run them all`)
  }
  const picked = new Set<number>()
  for (const selector of selectors) {
    if (typeof selector === 'number') {
      if (!Number.isInteger(selector) || selector < 1 || selector > steps.length) {
        throw new Error(`${id} has no step ${selector}: its steps are 1 to ${steps.length}`)
      }
      picked.add(selector - 1)
      continue
    }
    const matching = steps.flatMap((step, index) => (stepLabel(step) === selector ? [index] : []))
    if (matching.length === 0) {
      const names = steps.map((step) => `"${stepLabel(step)}"`).join(', ')
      throw new Error(`${id} has no step called "${selector}". Its steps: ${names}`)
    }
    for (const index of matching) picked.add(index)
  }
  return [...picked].sort((a, b) => a - b)
}

function noSuchCollection(name: string, project: OpenProject): string {
  const ids = project.collections.map(idOf)
  const folder = project.collections.some((c) => c.directory === name.replace(/\/+$/, ''))
  const shown = ids.length > 30 ? `${ids.slice(0, 30).join(', ')}, …` : ids.join(', ')
  return (
    (folder
      ? `"${name}" is a folder: run its collections one at a time.`
      : `No collection is called "${name}".`) +
    (ids.length > 0 ? ` This project has: ${shown}` : ` This project has no collections.`)
  )
}

/** Values given in code are plain data, as variables are (SPEC.md §4). */
function checkValues(values: Record<string, unknown> | undefined, what: string): void {
  for (const [name, value] of Object.entries(values ?? {})) {
    const kind = typeof value
    if (value !== null && kind !== 'string' && kind !== 'number' && kind !== 'boolean') {
      throw new TypeError(`${what}.${name} must be a string, number, boolean or null`)
    }
  }
}
