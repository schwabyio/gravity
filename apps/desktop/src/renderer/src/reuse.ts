import type { CollectionSummary, RunResult } from '@schwabyio/gravity-core/model'
import type { LibraryFileView, RequestSetView } from '@shared/ipc.js'

/**
 * The request set a use step names, as the runner finds it (SPEC.md §2.5):
 * the project's own first, then its global project's; `global:name` only the
 * global project's.
 */
export function resolveSet(sets: RequestSetView[], reference: string): RequestSetView | null {
  if (reference.startsWith('global:')) {
    const name = reference.slice('global:'.length)
    return sets.find((set) => set.source === 'global' && set.name === name) ?? null
  }
  return (
    sets.find((set) => set.source === 'project' && set.name === reference) ??
    sets.find((set) => set.source === 'global' && set.name === reference) ??
    null
  )
}

/** How a step names a set: plain for the project's own, `global:` when the project has one too. */
export function referenceFor(sets: RequestSetView[], set: RequestSetView): string {
  if (set.source === 'project') return set.name
  const shadowed = sets.some((other) => other.source === 'project' && other.name === set.name)
  return shadowed ? `global:${set.name}` : set.name
}

/** Where a use step's results live: one per request of its set. */
export const childKey = (stepId: string, child: number) => `${stepId}#${child}`

/** A use step's results, one per request of its set, in order. */
export function childResultsOf(
  results: Record<string, RunResult>,
  stepId: string,
  count: number
): Array<RunResult | undefined> {
  return Array.from({ length: count }, (_, child) => results[childKey(stepId, child)])
}

/** A request set as the sidebar opens it: like any collection file. */
export const summaryOfSet = (set: RequestSetView): CollectionSummary =>
  summaryOfFile({ ...set, stepCount: set.steps.length }, 'requests')

/** A library file — a request set, an endpoints file, a base — opened as a collection. */
export const summaryOfFile = (
  file: Pick<LibraryFileView, 'path' | 'name' | 'title' | 'stepCount' | 'problem'>,
  home: 'requests' | 'endpoints' | 'bases'
): CollectionSummary => ({
  path: file.path,
  relativePath: `${home}/${file.name}.yml`,
  directory: null,
  name: file.title,
  stepCount: file.stepCount,
  tags: [],
  environmentsPath: null,
  problems: file.problem ? [{ path: `${home}/${file.name}.yml`, message: file.problem }] : []
})
