import type { RunResult } from '@schwabyio/gravity-core'
import type { HtmlCollection, HtmlRun } from './html.js'
import type { LoadedCollection } from '@schwabyio/gravity-core'
import type { RunTarget } from './select.js'
import { unattempted, type StepRef } from './job.js'

/**
 * The run as JSON, for machines: CI tooling, scripts, and agents debugging a
 * failure. Written to `<testResultsBasePath>/json/results.json`, and printed
 * to stdout by `gta … --json`.
 *
 * Each step's result is core's `RunResult` — the contract the app, the
 * console and the other reports are all made from — with where the step is in
 * its file beside it, so a failure leads straight to the YAML that caused it.
 * Secrets are already `[secret: NAME]`, as everywhere else.
 *
 * `formatVersion` changes when a field is removed or changes meaning; adding
 * one does not.
 */
export const JSON_FORMAT_VERSION = 1

/** A request or response body longer than this is cut; `truncated` says which, and by how much. */
const BODY_LIMIT = 256 * 1024

/** Where the run's other reports were written, absolute; absent when not written. */
export interface ReportPaths {
  junit?: string
  html?: string
  json?: string
}

export function jsonReport(run: HtmlRun, reports: ReportPaths): object {
  const tallies = run.collections.map((c) => c.tally)
  const sum = (pick: (t: HtmlCollection['tally']) => number) =>
    tallies.reduce((n, t) => n + pick(t), 0)
  const failed = tallies.filter((t) => !t.passed).length
  return {
    formatVersion: JSON_FORMAT_VERSION,
    tool: { name: 'gta', version: run.version },
    project: { name: run.project, root: run.root },
    run: {
      result: failed === 0 ? 'passed' : 'failed',
      startedAt: new Date(run.startedAt).toISOString(),
      durationMs: Math.round(run.durationMs),
      environment: run.environment,
      /** The feature flag values the run used, where each came from, and the command run (SPEC.md §2.9). */
      flags: {
        values: run.flags ?? {},
        sources: run.flagSources ?? {},
        command: run.flagCommand ?? null
      },
      settings: {
        limitConcurrency: run.concurrency,
        timeoutCollection: run.timeoutCollection,
        bail: run.bail,
        tags: run.tags,
        notTags: run.notTags ?? []
      }
    },
    totals: {
      collections: { total: tallies.length, passed: tallies.length - failed, failed },
      steps: {
        total: sum((t) => t.steps.total),
        passed: sum((t) => t.steps.passed),
        failed: sum((t) => t.steps.failed),
        errored: sum((t) => t.steps.errored),
        skipped: sum((t) => t.steps.skipped)
      },
      assertions: {
        total: sum((t) => t.assertions.total),
        passed: sum((t) => t.assertions.passed),
        failed: sum((t) => t.assertions.failed)
      }
    },
    leftOut: { excluded: run.excluded, untagged: run.untagged },
    reports,
    collections: run.collections.map(collectionOf)
  }
}

function collectionOf(c: HtmlCollection): object {
  const { outcome, tally } = c
  return {
    id: c.id,
    file: c.file,
    status: tally.skipped ? 'skipped' : tally.passed ? 'passed' : 'failed',
    startedAt: new Date(c.startedAt).toISOString(),
    durationMs: Math.round(c.durationMs),
    counts: { steps: tally.steps, assertions: tally.assertions },
    /** Why it did not run at all, or null when it ran. */
    error: outcome.ok ? null : outcome.message,
    /** The data file that ran it once per row (SPEC.md §2.8), or null. */
    dataFile: outcome.ok ? outcome.data : null,
    /** Steps a bail left unrun. */
    notRun: outcome.ok ? unattempted(outcome.summary) : tally.steps.total,
    steps: outcome.ok
      ? outcome.summary.results.map((result, i) =>
          stepOf(result, outcome.steps[i] ?? { index: i, line: null })
        )
      : []
  }
}

function stepOf(result: RunResult, ref: StepRef): object {
  const truncated: Record<string, number> = {}
  const clip = (field: string, text: string | null): string | null => {
    if (text === null || text.length <= BODY_LIMIT) return text
    truncated[field] = text.length
    return text.slice(0, BODY_LIMIT)
  }
  const request = { ...result.request, body: clip('request.body', result.request.body) }
  const response = result.response
    ? { ...result.response, body: clip('response.body', result.response.body) ?? '' }
    : null
  return {
    /** The step's place in the file's `steps`, from 0, and its line, from 1. */
    step: { index: ref.index, line: ref.line },
    /** The data file row it ran with, from 1, or null without a data file. */
    iteration: ref.iteration ?? null,
    ...result,
    request,
    response,
    /** Fields cut short, with their full length in characters. */
    ...(Object.keys(truncated).length > 0 ? { truncated } : {})
  }
}

/** `gta get --json`: what `gta all` would run, without running it. */
export function jsonListing(options: {
  project: { name: string; root: string }
  environments: readonly string[]
  environmentType: string | null
  flags: { values: Record<string, string | number | boolean>; sources: Record<string, string> }
  tags: readonly string[]
  notTags?: readonly string[]
  targets: readonly RunTarget[]
  excluded: readonly string[]
  untagged: number
}): object {
  return {
    formatVersion: JSON_FORMAT_VERSION,
    project: options.project,
    environments: options.environments,
    environmentType: options.environmentType,
    flags: { values: options.flags.values, sources: options.flags.sources },
    tags: options.tags,
    notTags: options.notTags ?? [],
    collections: options.targets.map((target) => ({
      id: target.id,
      file: fileOf(target.collection),
      directory: target.collection.directory,
      steps: target.steps ?? target.collection.doc.steps.map((_, i) => i),
      stepCount: target.collection.doc.steps.length,
      dataFile: target.collection.dataFile
        ? {
            file: `collections/${target.collection.dataFile.relativePath}`,
            rows: target.collection.dataFile.rows
          }
        : null,
      tags: target.collection.doc.tags ?? [],
      broken: target.broken
    })),
    leftOut: { excluded: options.excluded, untagged: options.untagged }
  }
}

const fileOf = (collection: LoadedCollection) => `collections/${collection.relativePath}`

/** What `--json` prints when gta cannot run at all, so stdout is JSON whatever happens. */
export const jsonError = (message: string, exitCode: number): object => ({
  formatVersion: JSON_FORMAT_VERSION,
  error: { message, exitCode }
})
