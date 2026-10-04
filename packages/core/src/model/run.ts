import { z } from 'zod'

/**
 * `RunResult` is the single contract between the engine and everything that
 * renders it: the desktop response panel today, the CLI's HTML and JUnit
 * reporters later. Treat changes to it as breaking.
 */

export const HeaderEntrySchema = z.object({
  name: z.string(),
  value: z.string()
})
export type HeaderEntry = z.infer<typeof HeaderEntrySchema>

export const TimingsSchema = z.object({
  /** Epoch milliseconds at which the request was handed to the HTTP client. */
  startedAt: z.number(),
  /** Milliseconds until response headers arrived. */
  ttfbMs: z.number(),
  /** Milliseconds until the response body was fully read, or an event stream stopped. */
  totalMs: z.number()
})
export type Timings = z.infer<typeof TimingsSchema>

/**
 * A body preview classification, so the UI can pick a highlighter. `events` is
 * a `text/event-stream` body: its text as received, read as a list of events.
 */
export const BodyKindSchema = z.enum(['json', 'xml', 'html', 'text', 'binary', 'empty', 'events'])
export type BodyKind = z.infer<typeof BodyKindSchema>

/**
 * What stopped a step's reading of an event stream (SPEC.md §2.3, §2.11): the
 * server closing it; `maxEvents`, `streamTimeout` or `untilEvent`; the safety
 * limit; Stop in the app; or, for a step on a connection that sets none of
 * the three, nothing to wait for, so it took the events already held.
 */
export const StreamEndSchema = z.enum([
  'close',
  'maxEvents',
  'streamTimeout',
  'untilEvent',
  'limit',
  'stopped',
  'held'
])
export type StreamEnd = z.infer<typeof StreamEndSchema>

/** How an event stream was read (SPEC.md §2.3). */
export const EventStreamReadSchema = z.object({
  endedBy: StreamEndSchema,
  /** Milliseconds from the response headers to each event, in order. */
  at: z.array(z.number()),
  /**
   * For a step that opens or reads a connection (SPEC.md §2.11): its name, and
   * whether it was still open when the step's reading stopped.
   */
  connection: z.object({ name: z.string(), open: z.boolean() }).optional()
})
export type EventStreamRead = z.infer<typeof EventStreamReadSchema>

export const SentRequestSchema = z.object({
  method: z.string(),
  /** Final URL, after variable interpolation. */
  url: z.string(),
  headers: z.array(HeaderEntrySchema),
  body: z.string().nullable()
})
export type SentRequest = z.infer<typeof SentRequestSchema>

export const ReceivedResponseSchema = z.object({
  status: z.number(),
  statusText: z.string(),
  /** URL the response actually came from, after any redirects. */
  url: z.string(),
  headers: z.array(HeaderEntrySchema),
  body: z.string(),
  bodyKind: BodyKindSchema,
  /** Size of the response body on the wire, in bytes; for an event stream, of what `body` kept. */
  sizeBytes: z.number(),
  /** Number of redirects followed to reach this response. */
  redirectCount: z.number(),
  timings: TimingsSchema,
  /** For an event stream: why the reading stopped, and when each event came. */
  stream: EventStreamReadSchema.optional()
})
export type ReceivedResponse = z.infer<typeof ReceivedResponseSchema>

/**
 * Whose script something came from: an endpoint base's, the base collection's,
 * the collection's, the request set's, the step's own, or the tests on the use
 * step that ran the set.
 */
export const ScriptOwnerSchema = z.enum(['endpoint', 'base', 'collection', 'set', 'step', 'use'])
export type ScriptOwner = z.infer<typeof ScriptOwnerSchema>

/**
 * Where a script made a check, or ignored a property: whose `tests`, and the
 * line there, 1-based. The innermost line of that script on the stack, so a
 * check a check file makes is the line that called it.
 */
export const ScriptSourceSchema = z.object({ script: ScriptOwnerSchema, line: z.number() })
export type ScriptSource = z.infer<typeof ScriptSourceSchema>

/** `custom` is a named check from `gta.test()` in a step's `tests`. */
export const AssertionTargetSchema = z.enum(['status', 'header', 'body', 'strict', 'custom'])
export type AssertionTarget = z.infer<typeof AssertionTargetSchema>

export const AssertionResultSchema = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail']),
  message: z.string().optional(),
  /** What was checked. Optional so script-authored results can omit it. */
  target: AssertionTargetSchema.optional(),
  /** The header name, or the body path exactly as authored. */
  path: z.string().optional(),
  /** What the assertion wanted, for display. */
  expected: z.string().optional(),
  /** What the response had, for display; absent when nothing was there. */
  actual: z.string().optional(),
  /** Strict validation only: body paths nothing asserted, ignored or captured. */
  unasserted: z.array(z.string()).optional(),
  /**
   * A body check only: the paths its content vouched for, as strict validation
   * counts them — the whole value an equality compared, the very properties
   * an unordered array check matched in the items it matched, nothing inside
   * a container a length check measured. What a viewer marks as checked.
   */
  covered: z.array(z.string()).optional(),
  /** Where the check was made. Absent for one no line made, such as strict validation's verdict. */
  source: ScriptSourceSchema.optional()
})

/**
 * A body path the tests ignored: under strict validation, counted as checked
 * without being checked (`gta.ignoreResponseBodyProperty`, SPEC.md §3). Not a
 * check, so never counted as one.
 */
export const IgnoredPathSchema = z.object({
  /** As a path is written: `subAccounts`, or `account[].id.value` for every item's. */
  path: z.string(),
  source: ScriptSourceSchema.optional()
})
export type IgnoredPath = z.infer<typeof IgnoredPathSchema>
export type AssertionResult = z.infer<typeof AssertionResultSchema>

/** A line a script wrote with `console`. */
export const LogEntrySchema = z.object({
  level: z.enum(['log', 'info', 'warn', 'error']),
  message: z.string(),
  /** Which script wrote it. */
  phase: z.enum(['pre-request', 'tests'])
})
export type LogEntry = z.infer<typeof LogEntrySchema>

export const RunErrorSchema = z.object({
  /**
   * Which stage failed, so the UI can say where without guessing. `body` is a
   * file the body names that could not be read (SPEC.md §2.2); `connection`, a
   * step reading a connection that is not open (§2.11).
   */
  phase: z.enum([
    'use',
    'flags',
    'forEach',
    'interpolate',
    'body',
    'pre-request',
    'http',
    'connection',
    'tests'
  ]),
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
  /** For a script error: the line in that script, 1-based. */
  line: z.number().optional(),
  /** For a script error: whose script it was. */
  script: ScriptOwnerSchema.optional()
})
export type RunError = z.infer<typeof RunErrorSchema>

export const RunStatusSchema = z.enum(['pass', 'fail', 'error', 'skipped'])
export type RunStatus = z.infer<typeof RunStatusSchema>

export const RunResultSchema = z.object({
  item: z.object({
    /** Collection-relative path, or `null` for an unsaved scratchpad request. */
    path: z.string().nullable(),
    name: z.string(),
    seq: z.number().nullable()
  }),
  request: SentRequestSchema,
  response: ReceivedResponseSchema.nullable(),
  assertions: z.array(AssertionResultSchema),
  /** Body paths the tests ignored, in the order they did, when they ignored any. */
  ignored: z.array(IgnoredPathSchema).optional(),
  /**
   * `gta.sortResponseBodyArrays` as applied, when it was. Body paths in `assertions`
   * refer to the body after this sort, so a viewer re-applies it to line up.
   */
  sortedBy: z.array(z.string()).optional(),
  /** What the step's scripts wrote with `console`, in order. */
  logs: z.array(LogEntrySchema).optional(),
  error: RunErrorSchema.nullable(),
  status: RunStatusSchema,
  /**
   * Why a `skipped` step did not run: a feature flag it needs (SPEC.md §2.9),
   * `gta.skip` or `gta.skipRest` (§5), or an empty `forEach` list.
   */
  skipped: z.object({ reason: z.string() }).optional(),
  /** Wall-clock milliseconds for the whole item, scripts included. */
  durationMs: z.number(),
  /**
   * For a request run by a use step: the set as `use:` names it, the use
   * step's own `name` when it has one, and which step of the set it was
   * (0-based) of how many. Absent for a collection's own request.
   */
  use: z
    .object({ set: z.string(), name: z.string().optional(), child: z.number(), of: z.number() })
    .optional(),
  /** For a `setup` or `teardown` step: which list it is in (SPEC.md §2.10). Absent for `steps`. */
  stage: z.enum(['setup', 'teardown']).optional(),
  /** For a step with `forEach`: which item this request was for, from 0, of how many. */
  forEach: z.object({ index: z.number(), of: z.number(), item: z.string() }).optional()
})
export type RunResult = z.infer<typeof RunResultSchema>

/**
 * What a report calls a result (SPEC.md §2.5): its step's name, or for a
 * request run by a named use step, the use step's name, followed by the set's
 * step when the set has more than one: `create user › get profile`. A setup or
 * teardown step says so first, and one of a `forEach` says which item after:
 * `teardown › remove grant (item 2 of 3)`.
 */
export function resultName(result: RunResult): string {
  const use = result.use
  const name = !use?.name
    ? result.item.name
    : use.of === 1
      ? use.name
      : `${use.name} › ${result.item.name}`
  const each = result.forEach ? ` (item ${result.forEach.index + 1} of ${result.forEach.of})` : ''
  return `${result.stage ? `${result.stage} › ` : ''}${name}${each}`
}

/** Totals for a whole-collection run. */
export const CollectionRunSummarySchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  /**
   * Steps not run: those a feature flag skipped (results with status
   * `skipped`), and those never attempted because the run bailed or was cancelled.
   */
  skipped: z.number(),
  durationMs: z.number(),
  results: z.array(RunResultSchema)
})
export type CollectionRunSummary = z.infer<typeof CollectionRunSummarySchema>

/** Derive the overall status from what happened. */
export function deriveStatus(
  assertions: AssertionResult[],
  error: RunError | null,
  hasResponse: boolean
): RunStatus {
  if (error) return 'error'
  if (!hasResponse) return 'error'
  return assertions.some((a) => a.status === 'fail') ? 'fail' : 'pass'
}
