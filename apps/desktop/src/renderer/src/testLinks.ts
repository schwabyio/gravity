import type { AssertionResult } from '@schwabyio/gravity-core/model'

// Which lines and headers a check marks lives in core, shared with the CLI's HTML report.
export {
  MARK_GLYPH,
  buildChecks,
  checkedBody,
  checkedDiffersFromRaw,
  markHeaders,
  markLines,
  markStatus,
  type BodyLine,
  type Check,
  type CheckedBody,
  type Mark,
  type Marked
} from '@schwabyio/gravity-core/model'

/** Which response tab shows what an assertion is about. */
export function tabFor(assertion: AssertionResult): 'body' | 'headers' | null {
  if (assertion.target === 'body' || assertion.target === 'strict') return 'body'
  if (assertion.target === 'header') return 'headers'
  return null
}
