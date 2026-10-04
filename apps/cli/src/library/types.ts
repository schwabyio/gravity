/**
 * The types of gta's library, `@schwabyio/gta`: a project's collections and
 * request sets run from code, such as a Playwright test.
 *
 * Written out here rather than taken from the core, so the published `.d.ts`
 * files stand alone: the core's are zod's inferences, and neither ships.
 * `project.ts` fails to compile when the two drift apart.
 */

/** A variable's value: plain data only (SPEC.md §4). */
export type VarValue = string | number | boolean | null

/** A feature flag's value (SPEC.md §2.9). */
export type FlagValue = string | number | boolean

export interface HeaderEntry {
  name: string
  value: string
}

export interface SentRequest {
  method: string
  /** After variables are resolved. */
  url: string
  headers: HeaderEntry[]
  body: string | null
}

/** How an event stream was read (SPEC.md §2.3). */
export interface EventStreamRead {
  endedBy: 'close' | 'maxEvents' | 'streamTimeout' | 'untilEvent' | 'limit' | 'stopped' | 'held'
  /** Milliseconds from the response headers to each event, in order. */
  at: number[]
  /** For a step that opens or reads a connection (SPEC.md §2.11). */
  connection?: { name: string; open: boolean }
}

export interface ReceivedResponse {
  status: number
  statusText: string
  /** Where the response came from, after any redirects. */
  url: string
  headers: HeaderEntry[]
  body: string
  bodyKind: 'json' | 'xml' | 'html' | 'text' | 'binary' | 'empty' | 'events'
  sizeBytes: number
  redirectCount: number
  timings: {
    /** Epoch milliseconds. */
    startedAt: number
    ttfbMs: number
    totalMs: number
  }
  stream?: EventStreamRead
}

/** Whose script something came from. */
export type ScriptOwner =
  'endpoint-file' | 'endpoint' | 'base' | 'collection' | 'set' | 'step' | 'use'

/** Where a script made a check: whose script, and its line there, from 1. */
export interface ScriptSource {
  script: ScriptOwner
  line: number
  /** For a check a check file made: that file, and its line. */
  check?: { file: string; line: number }
}

/** One check a step's tests made. */
export interface AssertionResult {
  name: string
  status: 'pass' | 'fail'
  message?: string
  target?: 'status' | 'header' | 'body' | 'strict' | 'custom'
  /** The header name, or the body path as written. */
  path?: string
  expected?: string
  actual?: string
  /** Strict validation only: body paths nothing checked. */
  unasserted?: string[]
  /** A body check only: the paths it vouched for. */
  covered?: string[]
  source?: ScriptSource
}

export interface RunError {
  phase:
    | 'use'
    | 'flags'
    | 'forEach'
    | 'interpolate'
    | 'body'
    | 'pre-request'
    | 'http'
    | 'connection'
    | 'tests'
  message: string
  code?: string
  stack?: string
  /** For a script error: its line in that script, from 1. */
  line?: number
  script?: ScriptOwner
}

/** One request a run sent, and what came of it: the same result gta's JSON report holds. */
export interface RunResult {
  item: { path: string | null; name: string; seq: number | null }
  request: SentRequest
  response: ReceivedResponse | null
  assertions: AssertionResult[]
  /** Body paths the tests ignored (`gta.ignoreResponseBodyProperty`). */
  ignored?: Array<{ path: string; source?: ScriptSource }>
  /** `gta.sortResponseBodyArrays` as applied. */
  sortedBy?: string[]
  /** What the step's scripts wrote with `console`. */
  logs?: Array<{
    level: 'log' | 'info' | 'warn' | 'error'
    message: string
    phase: 'pre-request' | 'tests'
  }>
  error: RunError | null
  status: 'pass' | 'fail' | 'error' | 'skipped'
  /** Why a skipped step did not run. */
  skipped?: { reason: string }
  durationMs: number
  /** For a request a use step ran: the set, the use step's name, and which of the set's steps, from 0. */
  use?: { set: string; name?: string; child: number; of: number }
  /** For a setup or teardown step. */
  stage?: 'setup' | 'teardown'
  /** For a step with `forEach`: which item, from 0. */
  forEach?: { index: number; of: number; item: string }
}

/** A run's totals, and every result. */
export interface CollectionRunSummary {
  total: number
  passed: number
  failed: number
  errored: number
  /** Skipped by a flag or a script, and never attempted after a bail or a cancel. */
  skipped: number
  durationMs: number
  results: RunResult[]
}

/** Where a result's step is written, for a person to go and look. */
export interface StepRef {
  /** The file, absolute: the collection's, or for `use`, the request set's. */
  file: string
  /** The step's line in it, from 1; null when it cannot be told. */
  line: number | null
  /** The step's place in its list, from 0. */
  index: number
  /** For a setup or teardown step, which list it is in. */
  stage?: 'setup' | 'teardown'
  /** For a collection with a data file: the row it ran with, from 1. */
  iteration?: { index: number; of: number; label: string | null }
}

export interface OpenOptions {
  /** The environment to run against, by name. Absent: `environmentType` from settings.yml. */
  environment?: string
  /** Feature flag values, over the environment's and `GTA_FLAG_*` (SPEC.md §2.9). */
  flags?: Record<string, FlagValue>
  /** Stop a run at its first failing step. Absent: `bail` from settings.yml. */
  bail?: boolean
  /** Milliseconds a run may take before it is stopped. Absent: `timeoutCollection` from settings.yml. */
  timeoutCollection?: number
}

export interface RunOptions {
  /**
   * The steps to run: a step's name, as reports show it, or its place in
   * `steps:` from 1. They run in the file's order. Absent: every step. Setup
   * and teardown run either way.
   */
  steps?: ReadonlyArray<string | number>
  /** Values to start with, over the environment and under a data row. */
  vars?: Record<string, VarValue>
  /** Stop at the first failing step. Absent: the project's `bail`. */
  bail?: boolean
  signal?: AbortSignal
  /** As each request finishes, with the step it came from. */
  onResult?: (result: RunResult, step: StepRef) => void
}

export type UseOptions = Omit<RunOptions, 'steps'>

export interface RunOutcome {
  /** Nothing failed or errored, and the run finished. */
  passed: boolean
  /** The collection's id, or the request set as `use` named it. */
  id: string
  /** Its file, absolute. */
  file: string
  /** Why it did not run, or did not finish: a file that will not load, a timeout, a cancel. */
  error: string | null
  /** Every request's result, in order, secrets hidden. */
  summary: CollectionRunSummary
  /** Where each result's step is: one per result, in the same order. */
  steps: StepRef[]
  /**
   * Every value the run set or captured, by name: `gta.set`, and checks that
   * save what they read. The last one set wins. Not redacted.
   */
  values: Record<string, VarValue>
  /** What went wrong, as gta prints it under Failures; empty when it passed. */
  failures: string
}

/** A project, open: its settings read, its feature flags resolved. */
export interface GravityProject {
  /** The project folder, absolute. */
  readonly root: string
  /** `name` from project.yml, or the folder's name. */
  readonly name: string
  /** The environment runs use; null for none. */
  readonly environment: string | null
  /** The environments it has. */
  readonly environments: string[]
  readonly flags: Record<string, FlagValue>
  /** Its collections, by id. */
  readonly collections: string[]
  /** Problems with the project's layout that stop nothing, such as a folder too deep. */
  readonly warnings: string[]
  /**
   * Run a collection, named by its id or its place in `collections/`
   * (`checkout/sessions`): setup, its steps once for each data row, then
   * teardown, as gta runs it. Resolves however the steps fare; rejects only
   * for a name nothing answers to.
   */
  run(collection: string, options?: RunOptions): Promise<RunOutcome>
  /**
   * Run a request set as a use step would (SPEC.md §2.5): `login` is
   * `requests/login.yml`, in the project or its global project. A param left
   * out takes its default.
   */
  use(set: string, params?: Record<string, VarValue>, options?: UseOptions): Promise<RunOutcome>
}

/** Open the project in `folder`, the one holding `collections/`. */
export type OpenProjectFunction = (folder: string, options?: OpenOptions) => Promise<GravityProject>
