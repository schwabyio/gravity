import path from 'node:path'
import {
  isUseStep,
  readParam,
  STEP_LISTS,
  type Collection,
  type ParamSpec,
  type Stage,
  type Step,
  type VarValue
} from '../model/documents.js'
import type { RunError } from '../model/run.js'
import { interpolate } from '../vars/interpolate.js'
import { InterpolationError, ParamsScope, type VariableScope } from '../vars/scope.js'
import { resolveBase, resolveRequestSet } from '../workspace/library.js'
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
  /** The use step's own `name`, when it has one: reports name the set's requests by it. */
  useName: string | undefined
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
        useName: step.name?.trim() ? step.name : undefined,
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
 * A set's params for one use, resolved when the set starts, so its scripts
 * see the values its requests send (SPEC.md §2.5): what `with:` gives, its
 * `{{variables}}` read now, else each param's default, read the same way. A
 * default may name another param, as in `'{{params.id}}@example.com'`; each is
 * resolved once, so a `{{$uuid}}` is one value wherever it is read. A param
 * with neither (running a set on its own) is left out, so `{{params.x}}`
 * reports it.
 */
export function resolveParams(
  specs: Record<string, ParamSpec> | undefined,
  given: Record<string, VarValue>,
  scope: VariableScope
): Record<string, VarValue> {
  const params: Record<string, VarValue> = {}
  const defaults = new Map<string, VarValue>()
  for (const [key, spec] of Object.entries(specs ?? {})) {
    const value = given[key]
    if (value !== undefined)
      params[key] = typeof value === 'string' ? interpolate(value, scope) : value
    else {
      const fallback = readParam(spec).default
      if (fallback !== undefined) defaults.set(key, fallback)
    }
  }

  const resolving: string[] = []
  const resolve = (key: string) => {
    const fallback = defaults.get(key)
    if (fallback === undefined || Object.hasOwn(params, key)) return
    if (resolving.includes(key)) {
      const chain = [...resolving, key].map((name) => `params.${name}`)
      throw new InterpolationError(
        `params.${key} refers to itself: ${chain.join(' -> ')}`,
        `params.${key}`
      )
    }
    if (typeof fallback !== 'string') {
      params[key] = fallback
      return
    }
    // The params it names first, so it reads what they resolved to.
    resolving.push(key)
    for (const [, name] of fallback.matchAll(PARAM_REFERENCE)) resolve(name!)
    resolving.pop()
    try {
      params[key] = interpolate(fallback, new ParamsScope(scope, params))
    } catch (cause) {
      if (!(cause instanceof InterpolationError)) throw cause
      throw new InterpolationError(`params.${key}'s default: ${cause.message}`, cause.variable)
    }
  }
  for (const key of defaults.keys()) resolve(key)
  return params
}

/** `{{params.name}}`, in a param's default. */
const PARAM_REFERENCE = /\{\{\s*params\.([^{}\s]+)\s*\}\}/g

/** Something that stops a collection's `extends:` or one of its use steps (SPEC.md Appendix A). */
export interface ReferenceProblem {
  /** The use step's index in its list; null for `extends:`. */
  step: number | null
  /** The list, when it is `setup` or `teardown` rather than `steps`. */
  stage?: Stage
  message: string
}

/**
 * What a run of the collection would find wrong before sending anything: an
 * `extends:` or `use:` that names no usable file, a `with:` the set does not
 * take, a required param left out. For `gta get`, which runs nothing.
 */
export async function referenceProblems(
  collection: Collection,
  collectionPath: string
): Promise<ReferenceProblem[]> {
  const problems: ReferenceProblem[] = []
  if (collection.extends) {
    try {
      const { root, global } = await projectOf(collectionPath)
      await resolveBase(root, global, collection.extends)
    } catch (cause) {
      problems.push({ step: null, message: (cause as Error).message })
    }
  }
  for (const list of STEP_LISTS) {
    const steps = collection[list]
    if (!steps) continue
    for (const planned of await planSteps({ ...collection, steps }, collectionPath)) {
      if (planned.kind !== 'broken') continue
      const stage = list === 'steps' ? {} : { stage: list }
      problems.push({ step: planned.index, ...stage, message: planned.error.message })
    }
  }
  return problems
}
