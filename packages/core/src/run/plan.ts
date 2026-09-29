import path from 'node:path'
import {
  isUseStep,
  readParam,
  stepLabel,
  type Collection,
  type Step,
  type VarValue
} from '../model/documents.js'
import type { RunError } from '../model/run.js'
import { interpolate } from '../vars/interpolate.js'
import type { VariableScope } from '../vars/scope.js'
import { resolveRequestSet } from '../workspace/library.js'
import { projectRootOf, readProject } from '../workspace/project.js'

/**
 * What a collection run actually sends: every step in order, with each use
 * step replaced by its request set's steps (SPEC.md §2.5).
 */
export type PlannedStep =
  | { kind: 'request'; index: number; step: Step; set?: PlannedSet; child?: number }
  /** A use step that cannot run — no such set, a missing param — and why. */
  | { kind: 'broken'; index: number; step: Step; error: RunError }

export interface PlannedSet {
  /** As the use step named it. */
  name: string
  path: string
  doc: Collection
  /** The use step's `with:`, as written; strings are resolved when the set starts. */
  with: Record<string, VarValue>
  useTests: string | undefined
}

/** Steps as run, in order. A collection without use steps plans to itself. */
export async function planSteps(
  collection: Collection,
  collectionPath: string | null
): Promise<PlannedStep[]> {
  const planned: PlannedStep[] = []
  let project: Awaited<ReturnType<typeof projectOf>> | undefined

  for (const [index, step] of collection.steps.entries()) {
    if (!isUseStep(step)) {
      planned.push({ kind: 'request', index, step })
      continue
    }
    try {
      if (!collectionPath)
        throw new Error(`use: ${step.use} — save the collection in a project first`)
      project ??= await projectOf(collectionPath)
      const set = await resolveRequestSet(project.root, project.global, step.use)
      checkWith(step.use, set.doc, step.with ?? {})
      if (set.doc.steps.length === 0) throw new Error(`use: ${step.use} — the set has no steps`)
      const planSet: PlannedSet = {
        name: step.use,
        path: set.path,
        doc: set.doc,
        with: step.with ?? {},
        useTests: step.tests
      }
      set.doc.steps.forEach((child, number) => {
        planned.push({ kind: 'request', index, step: child, set: planSet, child: number })
      })
    } catch (cause) {
      planned.push({
        kind: 'broken',
        index,
        step,
        error: { phase: 'use', message: cause instanceof Error ? cause.message : String(cause) }
      })
    }
  }
  return planned
}

async function projectOf(collectionPath: string) {
  const root = projectRootOf(collectionPath) ?? path.dirname(collectionPath)
  const { global } = await readProject(root)
  return { root, global }
}

/**
 * A use step's values against its set's params: every required one given, and
 * nothing given that the set does not take — usually a typo that would
 * otherwise fall back to a default in silence.
 */
function checkWith(name: string, set: Collection, given: Record<string, VarValue>) {
  const params = set.params ?? {}
  const unknown = Object.keys(given).filter((key) => !(key in params))
  if (unknown.length > 0) {
    const takes = Object.keys(params).join(', ') || 'none'
    throw new Error(`use: ${name} — it takes no ${unknown.join(', ')} (it takes: ${takes})`)
  }
  const missing = Object.entries(params)
    .filter(([key, spec]) => readParam(spec).required && !(key in given))
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`use: ${name} — needs ${missing.join(', ')} in with:`)
  }
}

/**
 * A set's params for one use: what `with:` gives — its `{{variables}}`
 * resolved now, when the set starts — else each param's default. A param with
 * neither (running a set on its own) is left out, so `{{params.x}}` reports it.
 */
export function resolveParams(set: PlannedSet, scope: VariableScope): Record<string, VarValue> {
  const params: Record<string, VarValue> = {}
  for (const [key, spec] of Object.entries(set.doc.params ?? {})) {
    const given = set.with[key]
    if (given !== undefined)
      params[key] = typeof given === 'string' ? interpolate(given, scope) : given
    else {
      const fallback = readParam(spec).default
      if (fallback !== undefined) params[key] = fallback
    }
  }
  return params
}

/** A display name for a set's step: its own, under the use step that ran it. */
export const plannedLabel = (planned: PlannedStep): string => stepLabel(planned.step)
