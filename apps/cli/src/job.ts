import fs from 'node:fs/promises'
import { LineCounter, parseDocument } from 'yaml'
import path from 'node:path'
import {
  COLLECTIONS_DIR,
  loadCollection,
  readDataFile,
  redact,
  runSuite,
  secretValues,
  type CollectionRunSummary,
  type Stage
} from '@schwabyio/gravity-core'

/** One collection to run, as sent to a worker: plain data only. */
export interface CollectionJob {
  /** The collection file, absolute. */
  file: string
  projectRoot: string
  environment: string | null
  /** The steps to run, in order; null for every step. */
  steps: number[] | null
  bail: boolean
  /** The run's feature flag values, resolved once for every collection (SPEC.md §2.9). */
  flags: Record<string, string | number | boolean>
}

/**
 * Steps never attempted — a bail, a cancel, rows a failed setup stopped — as
 * against those a flag or a script skipped, which have results.
 */
export const unattempted = (summary: CollectionRunSummary): number =>
  summary.total - summary.results.length

/** Every step of it skipped, by a feature flag or a script: the collection neither passed nor failed. */
export const allSkipped = (summary: CollectionRunSummary): boolean =>
  summary.results.length > 0 && summary.results.every((r) => r.status === 'skipped')

/** Where a result's step is in the collection file, for a person or an agent to go and fix it. */
export interface StepRef {
  /** The step's place in its list in the file, from 0: `steps`, or `setup` or `teardown` when `stage` says. */
  index: number
  /** For a setup or teardown step, which list it is in (SPEC.md §2.10). */
  stage?: Stage
  /** Its line in the file, from 1; null when it cannot be told. */
  line: number | null
  /** For a collection with a data file: which row the result ran with, from 1. */
  iteration?: Iteration
}

export interface Iteration {
  index: number
  of: number
  /** The row's `iterationLabel`, when it has one. */
  label: string | null
}

/** `Iteration 2 (Expired token) - Get user`, as xrun named them; the step's name without a data file. */
export const iterationName = (name: string, ref: StepRef | undefined): string =>
  ref?.iteration
    ? `Iteration ${ref.iteration.index}${ref.iteration.label ? ` (${ref.iteration.label})` : ''} - ${name}`
    : name

export type JobOutcome =
  | {
      ok: true
      summary: CollectionRunSummary
      /** One per result, in the same order: the step each came from. */
      steps: StepRef[]
      /** The data file that drove it, from the project folder, and its row count. */
      data: { file: string; rows: number } | null
    }
  | { ok: false; message: string }

/**
 * Run one collection, start to finish, in whichever thread calls it.
 *
 * The file is read again here rather than passed in, so a worker gets a path
 * and nothing else it would have to trust.
 */
export async function runJob(job: CollectionJob): Promise<JobOutcome> {
  try {
    const loaded = await loadCollection(job.file, job.projectRoot)
    if (loaded.problems.length > 0) {
      return { ok: false, message: loaded.problems.map((p) => p.message).join('; ') }
    }
    const { steps } = loaded.doc
    const collection = job.steps
      ? {
          ...loaded.doc,
          steps: job.steps.map((index) => steps[index]).filter((s) => s !== undefined)
        }
      : loaded.doc
    const context = { collectionPath: loaded.path, environmentName: job.environment }
    const lines = await stepLines(loaded.path)
    const data = loaded.dataFile ? await readDataFile(loaded.dataFile.path) : null

    // Setup, then the steps once per data row (SPEC.md §2.8) — each row with a
    // scope of its own — or once without a data file, then teardown (§2.10).
    const refs: StepRef[] = []
    const summary = await runSuite({
      collection,
      collectionPath: loaded.path,
      context: { ...context, flags: job.flags, dataRow: null },
      rows: data
        ? data.rows.map((row, i) => ({
            source: `${path.basename(data.path)} row ${i + 1}`,
            vars: row.values,
            label: row.label
          }))
        : null,
      bail: job.bail,
      // Each result reports the step it ran under — a use step's requests all under it.
      onResult: (index, result, iteration) => {
        const stage = result.stage
        const step = stage ? index : job.steps ? (job.steps[index] ?? index) : index
        refs.push({
          index: step,
          line: lines[stage ?? 'steps'][step] ?? null,
          ...(stage ? { stage } : {}),
          ...(iteration ? { iteration } : {})
        })
      }
    })
    return {
      ok: true,
      summary: redact(summary, await secretValues(context)),
      steps: refs,
      data: loaded.dataFile
        ? { file: `${COLLECTIONS_DIR}/${loaded.dataFile.relativePath}`, rows: loaded.dataFile.rows }
        : null
    }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

/** The line each step of a collection file starts on, from 1, in each of its lists. */
async function stepLines(file: string): Promise<Record<'steps' | Stage, Array<number | null>>> {
  const lines = { setup: [], steps: [], teardown: [] }
  try {
    const counter = new LineCounter()
    const document = parseDocument(await fs.readFile(file, 'utf8'), { lineCounter: counter })
    const of = (key: string) => {
      const list = document.get(key, true)
      if (!list || typeof list !== 'object' || !('items' in list)) return []
      return (list.items as Array<{ range?: [number, number, number] | null }>).map((item) =>
        item?.range ? counter.linePos(item.range[0]).line : null
      )
    }
    return { setup: of('setup'), steps: of('steps'), teardown: of('teardown') }
  } catch {
    return lines
  }
}
