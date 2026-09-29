import type { Collection } from '@schwabyio/gravity-core/model'

/**
 * The step list's tag filter. Only a collection with step tags has one: its
 * own tags select the whole collection, so there is nothing to narrow by.
 */

/** Tags carried by this collection's steps, sorted; none without step tags. */
export function stepTagsIn(collection: Collection): string[] {
  if (!collection.stepTags) return []
  return [...new Set(collection.steps.flatMap((step) => step.tags ?? []))].sort()
}

/**
 * The filter as it applies here — tags no step carries are dropped — and the
 * step indexes it leaves, in order. An empty filter leaves every step.
 */
export function filterSteps(
  collection: Collection,
  filter: readonly string[]
): { active: string[]; indexes: number[] } {
  const present = stepTagsIn(collection)
  const active = filter.filter((tag) => present.includes(tag))
  const indexes = collection.steps
    .map((step, index) => ({ index, tags: step.tags ?? [] }))
    .filter(({ tags }) => active.length === 0 || active.some((tag) => tags.includes(tag)))
    .map(({ index }) => index)
  return { active, indexes }
}
