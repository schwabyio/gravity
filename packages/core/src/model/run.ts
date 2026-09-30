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
  /** Milliseconds until the response body was fully read. */
  totalMs: z.number()
})
export type Timings = z.infer<typeof TimingsSchema>

/** A body preview classification, so the UI can pick a highlighter. */
export const BodyKindSchema = z.enum(['json', 'xml', 'html', 'text', 'binary', 'empty'])
export type BodyKind = z.infer<typeof BodyKindSchema>

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
  /** Size of the response body on the wire, in bytes. */
  sizeBytes: z.number(),
  /** Number of redirects followed to reach this response. */
  redirectCount: z.number(),
  timings: TimingsSchema
})
export type ReceivedResponse = z.infer<typeof ReceivedResponseSchema>

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
  unasserted: z.array(z.string()).optional()
})
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
   * file the body names that could not be read (SPEC.md §2.2).
   */
  phase: z.enum(['use', 'flags', 'forEach', 'interpolate', 'body', 'pre-request', 'http', 'tests']),
  message: z.string(),
  code: z.string().optional(),
  stack: z.string().optional(),
  /** For a script error: the line in that script, 1-based. */
  line: z.number().optional(),
  /**
   * For a script error: whose script it was — the collection's, the request
   * set's, the step's own, or the tests on the use step that ran the set.
   */
  script: z.enum(['endpoint', 'base', 'collection', 'set', 'step', 'use']).optional()
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
