/**
 * `@schwabyio/gta/playwright`: Playwright's `test` with a `gta` fixture, which
 * runs the project's collections and request sets. Each run is a step in
 * Playwright's report, and each request a step inside it, with what was sent
 * and received attached. A run that fails fails the test.
 *
 *     // playwright.config.ts
 *     export default defineConfig<{}, GravityConfig>({
 *       use: { gravity: { project: '../api-tests', environment: 'staging' } }
 *     })
 *
 *     // a spec
 *     import { test, expect } from '@schwabyio/gta/playwright'
 *
 *     test('a new user sees their dashboard', async ({ page, gta }) => {
 *       const user = await gta.use('create-user', { plan: 'pro' })
 *       await page.goto(`/users/${user.values.userId}`)
 *     })
 *
 * Every export says its type outright, so the published `.d.ts` is made from
 * this file alone (build.mjs).
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test as base } from '@playwright/test'
import type {
  Location,
  PlaywrightTestArgs,
  PlaywrightTestOptions,
  PlaywrightWorkerArgs,
  PlaywrightWorkerOptions,
  TestType
} from '@playwright/test'
import { resultName } from '@schwabyio/gravity-core'
import { iterationName } from '../job.js'
import { openProject } from './project.js'
import type {
  GravityProject,
  OpenOptions,
  RunOptions,
  RunOutcome,
  RunResult,
  StepRef,
  UseOptions,
  VarValue
} from './types.js'

export interface GravityOptions extends OpenOptions {
  /** The project folder, relative to the Playwright config's folder. Absent: that folder. */
  project?: string
}

/** The `gravity` option, for `defineConfig<{}, GravityConfig>`. */
export interface GravityConfig {
  gravity: GravityOptions
}

export interface GtaRunOptions extends Omit<RunOptions, 'signal'> {
  /** On a failure, go on with the test and fail it at the end, as `expect.soft` does. */
  soft?: boolean
}

export interface GtaUseOptions extends Omit<UseOptions, 'signal'> {
  /** On a failure, go on with the test and fail it at the end, as `expect.soft` does. */
  soft?: boolean
}

/** The `gta` fixture. */
export interface Gta {
  /** The project, opened once for each worker. */
  readonly project: GravityProject
  /** `project.run`, reported as a step, failing the test when the run fails. */
  run(collection: string, options?: GtaRunOptions): Promise<RunOutcome>
  /** `project.use`, reported as a step, failing the test when the set fails. */
  use(set: string, params?: Record<string, VarValue>, options?: GtaUseOptions): Promise<RunOutcome>
}

export interface GravityFixtures {
  gta: Gta
}

export interface GravityWorkerFixtures extends GravityConfig {
  gravityProject: GravityProject
}

export type * from './types.js'

export { expect }

export const test: TestType<
  PlaywrightTestArgs & PlaywrightTestOptions & GravityFixtures,
  PlaywrightWorkerArgs & PlaywrightWorkerOptions & GravityWorkerFixtures
> = base.extend<GravityFixtures, GravityWorkerFixtures>({
  gravity: [{}, { scope: 'worker', option: true }],
  // Once for each worker: settings read, and an environment's flag command run, once.
  gravityProject: [
    async ({ gravity }, use, workerInfo) => {
      const { project = '.', ...options } = gravity
      const { configFile, rootDir } = workerInfo.config
      const from = configFile ? path.dirname(configFile) : rootDir
      await use(await openProject(path.resolve(from, project), options))
    },
    { scope: 'worker', title: 'open the Gravity project' }
  ],
  gta: async ({ gravityProject }, use) => {
    const runs: TestRuns = { ending: new AbortController(), running: new Set() }
    await use(gtaFor(gravityProject, runs))
    // A run still going when the test ends, as one that timed out, stops here,
    // and is waited for, so nothing of it outlasts the test.
    runs.ending.abort()
    await Promise.allSettled(runs.running)
  }
})

/** One test's runs: what stops them when it ends, and those not finished. */
interface TestRuns {
  ending: AbortController
  running: Set<Promise<RunOutcome>>
}

/**
 * A failed run's check. It throws its own error rather than returning a
 * verdict, so the error can point at the line that called `gta` — which
 * neither the matcher's frame nor a boxed step would — and `expect.soft`
 * still records it and goes on.
 */
const checks = expect.extend({
  toHavePassed(outcome: RunOutcome, title: string, caller: Location | undefined) {
    const message = messageOf(title, outcome)
    if (outcome.passed) return { pass: true, name: 'toHavePassed', message: () => message }
    const error = new Error(message)
    if (caller) {
      error.stack = `Error: ${message}\n    at ${caller.file}:${caller.line}:${caller.column}`
    }
    throw error
  }
})

/** `gta checkout: 1 of 4 steps failed`, then what failed, as gta prints it. */
function messageOf(title: string, outcome: RunOutcome): string {
  const { summary, error } = outcome
  const failed = summary.failed + summary.errored
  const headline = error
    ? `${title}: ${error}`
    : `${title}: ${failed} of ${summary.total} ${summary.total === 1 ? 'step' : 'steps'} failed`
  // The collection's name heads gta's failures, and the headline says it already.
  const details = outcome.failures
    .split('\n')
    .slice(1)
    .filter((line) => !error || line.trim() !== `✗ ${error}`)
  return details.length > 0 ? `${headline}\n\n${details.join('\n')}` : headline
}

function gtaFor(project: GravityProject, runs: TestRuns): Gta {
  return {
    project,
    run: (collection, { soft, onResult, ...options } = {}) =>
      reported(`gta ${collection}`, { soft, onResult }, runs, (hooks) =>
        project.run(collection, { ...options, ...hooks })
      ),
    use: (set, params, { soft, onResult, ...options } = {}) =>
      reported(`gta use ${set}`, { soft, onResult }, runs, (hooks) =>
        project.use(set, params, { ...options, ...hooks })
      )
  }
}

/**
 * A run as a step of the test, placed at the line that called `gta`: each
 * request a step inside it as it lands, then, should anything have failed,
 * one check that fails the test with all of it.
 */
async function reported(
  title: string,
  options: { soft: boolean | undefined; onResult: RunOptions['onResult'] },
  runs: TestRuns,
  start: (hooks: Required<Pick<RunOptions, 'signal' | 'onResult'>>) => Promise<RunOutcome>
): Promise<RunOutcome> {
  const location = callerLocation()
  return base.step(
    title,
    async () => {
      let reporting = Promise.resolve()
      const run = start({
        signal: runs.ending.signal,
        onResult: (result, step) => {
          options.onResult?.(result, step)
          reporting = reporting.then(() => reportResult(result, step))
        }
      })
      runs.running.add(run)
      const outcome = await run.finally(() => runs.running.delete(run))
      await reporting
      // Stopped because the test ended: Playwright has said why already.
      if (!outcome.passed && !runs.ending.signal.aborted) {
        if (options.soft) checks.soft(outcome).toHavePassed(title, location)
        else checks(outcome).toHavePassed(title, location)
      }
      return outcome
    },
    location ? { location } : {}
  )
}

/**
 * One request as a step, placed at its step in the YAML. A failure is shown
 * on the step, not thrown: the run's check fails the test once, with every
 * failure in it.
 */
async function reportResult(result: RunResult, step: StepRef): Promise<void> {
  await base
    .step(
      titleOf(result, step),
      async (info) => {
        // A skipped step sent nothing, whatever its request line says.
        if (result.status !== 'skipped' && result.request.url !== '') {
          await info.attach('request and response', { body: exchangeOf(result) })
        }
        if (result.status === 'skipped') info.skip(true, result.skipped?.reason)
        if (result.status === 'fail' || result.status === 'error') {
          throw new Error(problemsOf(result))
        }
      },
      { location: { file: step.file, line: step.line ?? 1, column: 1 } }
    )
    .catch(() => {})
}

/** `get profile · 404 · 143 ms`: the step as reports name it, its status and its time. */
function titleOf(result: RunResult, step: StepRef): string {
  const parts = [iterationName(resultName(result), step)]
  if (result.response) parts.push(String(result.response.status))
  else if (result.status === 'skipped') parts.push('skipped')
  if (result.status !== 'skipped') parts.push(`${Math.round(result.durationMs)} ms`)
  return parts.join(' · ')
}

/** What went wrong in one step: its error, and each check that failed. */
function problemsOf(result: RunResult): string {
  const lines: string[] = []
  if (result.error) lines.push(`${result.error.phase} error: ${result.error.message}`)
  for (const check of result.assertions) {
    if (check.status !== 'fail') continue
    lines.push(`${check.name}${check.message ? `: ${check.message}` : ''}`)
    if (check.expected !== undefined) lines.push(`  expected ${check.expected}`)
    if (check.actual !== undefined) lines.push(`  actual   ${check.actual}`)
  }
  return lines.join('\n') || 'failed'
}

/** A body longer than this is cut in an attachment. */
const BODY_LIMIT = 256 * 1024

const clip = (body: string): string =>
  body.length > BODY_LIMIT
    ? `${body.slice(0, BODY_LIMIT)}\n… (${body.length - BODY_LIMIT} more characters)`
    : body

/** The request as sent and the response as received, as text, then the checks. */
function exchangeOf(result: RunResult): string {
  const { request, response } = result
  const lines = [`${request.method} ${request.url}`]
  for (const header of request.headers) lines.push(`${header.name}: ${header.value}`)
  if (request.body) lines.push('', clip(request.body))
  lines.push('')
  if (response) {
    lines.push(
      `${response.status} ${response.statusText} · ${Math.round(response.timings.totalMs)} ms · ${response.sizeBytes} bytes`
    )
    for (const header of response.headers) lines.push(`${header.name}: ${header.value}`)
    if (response.body) lines.push('', clip(response.body))
  } else {
    lines.push(result.error ? `No response: ${result.error.message}` : 'No response')
  }
  if (result.assertions.length > 0) {
    lines.push('', 'Checks:')
    for (const check of result.assertions) {
      lines.push(`${check.status === 'pass' ? '✓' : '✕'} ${check.name}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/** This module's folder: every frame from in here, or beside it in the bundle, is gta's. */
const ours = path.dirname(fileURLToPath(import.meta.url))

/** Where the test called `gta`: the first frame on the stack that is not gta's own. */
function callerLocation(): Location | undefined {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    // `at fn (/a b/spec.ts:11:13)` or `at /a b/spec.ts:11:13`: a path may hold spaces.
    const match = /^\s*at (?:.*? \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(frame)
    if (!match) continue
    const file = match[1]!.startsWith('file://') ? fileURLToPath(match[1]!) : match[1]!
    if (file.startsWith('node:') || !path.isAbsolute(file)) continue
    if (file.startsWith(ours + path.sep) || path.dirname(file) === ours) continue
    if (file.includes(`${path.sep}node_modules${path.sep}`)) continue
    return { file, line: Number(match[2]), column: Number(match[3]) }
  }
  return undefined
}
