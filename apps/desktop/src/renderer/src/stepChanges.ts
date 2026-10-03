import {
  STEP_LISTS,
  stepLabel,
  type Collection,
  type Step,
  type StepList
} from '@schwabyio/gravity-core/model'

/**
 * What changed in a collection since its last commit, step by step: the
 * steps added, changed or moved, how many were removed, and whether anything
 * else of it — its headers, variables, scripts, settings — changed. Pure, so
 * the step list and its tests agree.
 *
 * Steps have no ids of their own in the file, so they are matched: first
 * those unchanged and in the same order; then one found unchanged elsewhere
 * is moved; then one with the same name as a step gone is changed; anything
 * left is new, and anything left of the commit removed.
 */
export type StepChange = 'new' | 'changed' | 'moved'

export interface CollectionChanges {
  /** Per list, one entry per step as it is now: what changed of it, or null. */
  steps: Record<StepList, Array<StepChange | null>>
  /** Per list, how many of the commit's steps are gone. */
  removed: Record<StepList, number>
  /** Anything of the collection besides its steps. */
  collection: boolean
}

/** A value as text with its keys in order, so two equal documents compare equal. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, (inner as Record<string, unknown>)[key]])
        )
      : inner
  )
}

/** The pairs of the longest run of equal keys common to both, in order: [before, now]. */
function commonRun(before: string[], now: string[]): Array<[number, number]> {
  const table = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(now.length + 1).fill(0)
  )
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = now.length - 1; j >= 0; j--) {
      table[i]![j] =
        before[i] === now[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < before.length && j < now.length) {
    if (before[i] === now[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++
    else j++
  }
  return pairs
}

function listChanges(
  before: Step[],
  now: Step[]
): { steps: Array<StepChange | null>; removed: number } {
  const beforeKeys = before.map(canonical)
  const nowKeys = now.map(canonical)
  const steps: Array<StepChange | null> = now.map(() => 'new')
  const left = new Set(before.map((_, index) => index))
  for (const [i, j] of commonRun(beforeKeys, nowKeys)) {
    steps[j] = null
    left.delete(i)
  }
  const take = (j: number, matches: (i: number) => boolean, change: StepChange) => {
    const found = [...left].find(matches)
    if (found === undefined) return
    steps[j] = change
    left.delete(found)
  }
  now.forEach((_step, j) => {
    if (steps[j] === 'new') take(j, (i) => beforeKeys[i] === nowKeys[j], 'moved')
  })
  now.forEach((step, j) => {
    if (steps[j] === 'new') take(j, (i) => stepLabel(before[i]!) === stepLabel(step), 'changed')
  })
  return { steps, removed: left.size }
}

const listOf = (doc: Collection, list: StepList): Step[] =>
  (list === 'steps' ? doc.steps : doc[list]) ?? []

/** Everything of a collection but its steps. */
function withoutSteps(doc: Collection): Record<string, unknown> {
  const { steps: _steps, setup: _setup, teardown: _teardown, ...rest } = doc
  return rest
}

export function changesSince(committed: Collection, now: Collection): CollectionChanges {
  const steps = {} as CollectionChanges['steps']
  const removed = {} as CollectionChanges['removed']
  for (const list of STEP_LISTS) {
    const changes = listChanges(listOf(committed, list), listOf(now, list))
    steps[list] = changes.steps
    removed[list] = changes.removed
  }
  return {
    steps,
    removed,
    collection: canonical(withoutSteps(committed)) !== canonical(withoutSteps(now))
  }
}

/** What a step's mark says, in words. */
export const STEP_CHANGE_WORDS: Record<StepChange, string> = {
  new: 'New since the last commit',
  changed: 'Changed since the last commit',
  moved: 'Moved since the last commit'
}
