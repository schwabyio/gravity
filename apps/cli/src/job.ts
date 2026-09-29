import fs from 'node:fs/promises'
import { LineCounter, parseDocument } from 'yaml'
import path from 'node:path'
import {
  COLLECTIONS_DIR,
  environmentLayer,
  loadCollection,
  readDataFile,
  runCollection,
  type CollectionRunSummary,
  type DataRow
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

/** Steps never attempted — a bail, a cancel — as against those a flag skipped, which have results. */
export const unattempted = (summary: CollectionRunSummary): number =>
  summary.total - summary.results.length

/** Every step of it skipped by a feature flag: the collection neither passed nor failed. */
export const allSkipped = (summary: CollectionRunSummary): boolean =>
  summary.results.length > 0 && summary.results.every((r) => r.status === 'skipped')

/** Where a result's step is in the collection file, for a person or an agent to go and fix it. */
export interface StepRef {
  /** The step's place in the file's `steps`, from 0. */
  index: number
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
    // A data file runs the whole collection once per row (SPEC.md §2.8), each
    // with a scope of its own; without one it runs once, with no row.
    const rows: Array<DataRow | null> = data ? data.rows : [null]

    const summaries: CollectionRunSummary[] = []
    const refs: StepRef[] = []
    let unrun = 0
    for (const [i, row] of rows.entries()) {
      const iteration = row ? { index: i + 1, of: rows.length, label: row.label } : undefined
      // Each result reports the step it ran under — a use step's requests all under it.
      const summary = await runCollection({
        collection,
        collectionPath: loaded.path,
        context: {
          ...context,
          flags: job.flags,
          dataRow: row
            ? { source: `${path.basename(data!.path)} row ${i + 1}`, vars: row.values }
            : null
        },
        bail: job.bail,
        onResult: (index) => {
          const step = job.steps ? (job.steps[index] ?? index) : index
          refs.push({ index: step, line: lines[step] ?? null, ...(iteration ? { iteration } : {}) })
        }
      })
      summaries.push(summary)
      // Bail stops the collection, every row still to come included.
      if (job.bail && summary.failed + summary.errored > 0) {
        unrun = summary.total * (rows.length - i - 1)
        break
      }
    }

    const summary: CollectionRunSummary = {
      total: summaries.reduce((n, s) => n + s.total, 0) + unrun,
      passed: summaries.reduce((n, s) => n + s.passed, 0),
      failed: summaries.reduce((n, s) => n + s.failed, 0),
      errored: summaries.reduce((n, s) => n + s.errored, 0),
      skipped: summaries.reduce((n, s) => n + s.skipped, 0) + unrun,
      durationMs: summaries.reduce((n, s) => n + s.durationMs, 0),
      results: summaries.flatMap((s) => s.results)
    }
    return {
      ok: true,
      summary: redact(summary, await secretsOf(context)),
      steps: refs,
      data: loaded.dataFile
        ? { file: `${COLLECTIONS_DIR}/${loaded.dataFile.relativePath}`, rows: loaded.dataFile.rows }
        : null
    }
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) }
  }
}

/**
 * The values of the environment's secrets, by name, longest first.
 *
 * SPEC.md §6: a secret is never written to a report. Its resolved value is in
 * what was sent — an `Authorization` header — and can come back in what was
 * received, a log line or an assertion's actual value, so every report `gta`
 * writes, the console included, is made from a redacted result.
 */
async function secretsOf(context: {
  collectionPath: string
  environmentName: string | null
}): Promise<Array<[string, string]>> {
  if (!context.environmentName) return []
  try {
    const layer = await environmentLayer(context, context.environmentName)
    return (layer.secrets ?? [])
      .flatMap((name): Array<[string, string]> => {
        const value = layer.vars[name]
        return value === undefined || value === null || String(value) === ''
          ? []
          : [[name, String(value)]]
      })
      .sort((a, b) => b[1].length - a[1].length)
  } catch {
    // A secret with no value fails the run itself, which says so.
    return []
  }
}

/** Every string in the result with each secret's value replaced by `[secret: NAME]`. */
export function redact<T>(value: T, secrets: ReadonlyArray<[string, string]>): T {
  if (secrets.length === 0) return value
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      return secrets.reduce(
        (text, [name, secret]) => text.split(secret).join(`[secret: ${name}]`),
        node
      )
    }
    if (Array.isArray(node)) return node.map(walk)
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, inner]) => [key, walk(inner)]))
    }
    return node
  }
  return walk(value) as T
}

/** The line each step of a collection file starts on, from 1. */
async function stepLines(file: string): Promise<Array<number | null>> {
  try {
    const counter = new LineCounter()
    const document = parseDocument(await fs.readFile(file, 'utf8'), { lineCounter: counter })
    const steps = document.get('steps', true)
    if (!steps || typeof steps !== 'object' || !('items' in steps)) return []
    return (steps.items as Array<{ range?: [number, number, number] | null }>).map((item) =>
      item?.range ? counter.linePos(item.range[0]).line : null
    )
  } catch {
    return []
  }
}
