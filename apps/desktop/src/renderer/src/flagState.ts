// Model only: the renderer never bundles the engine.
import {
  checkFlags,
  UnknownFlagError,
  type Collection,
  type FlagConditions,
  type FlagValue
} from '@schwabyio/gravity-core/model'

/**
 * What a step's feature flags (SPEC.md §2.9) mean with the current values,
 * before anything runs — so the step list can show which steps a run would
 * skip, and which name a flag nobody has declared.
 */
export type FlagState = { kind: 'skip'; reason: string } | { kind: 'error'; message: string } | null

/** Whether conditions hold: null when they do (or there are none). */
export function conditionsState(
  conditions: FlagConditions | undefined,
  values: Record<string, FlagValue> | null
): FlagState {
  try {
    const check = checkFlags(conditions, values)
    return check.run ? null : { kind: 'skip', reason: check.reason }
  } catch (cause) {
    if (cause instanceof UnknownFlagError) return { kind: 'error', message: cause.message }
    throw cause
  }
}

/** A step's state: the collection's conditions first, then its own, as a run checks them. */
export function stepFlagState(
  collection: Pick<Collection, 'flags' | 'steps'>,
  index: number,
  values: Record<string, FlagValue> | null
): FlagState {
  return (
    conditionsState(collection.flags, values) ??
    conditionsState(collection.steps[index]?.flags, values)
  )
}

/** `true`, `2`, `v2`: a flag value as it is typed and shown. */
export const showFlagValue = (value: FlagValue): string => String(value)
