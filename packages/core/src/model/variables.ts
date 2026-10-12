/**
 * Variable preview types.
 *
 * These live in the model rather than beside the resolver because the renderer
 * needs them, and the model entry point is the one it can import without
 * dragging the filesystem into a sandboxed bundle.
 */
import { stepLabel, type Collection } from './documents.js'

/**
 * How a variable's value is produced, which decides how the UI may show it.
 * `runtime` is one a step sets as it runs (`namesStepsSet`), with no value
 * until a Send or run sets it.
 */
export type VariableKind = 'static' | 'secret' | 'dynamic' | 'runtime'

export interface VariablePreview {
  /**
   * The resolved value as text.
   *
   * Null for a `dynamic` or `runtime` variable, whose value only exists during
   * a run, and for a `secret`, whose value is never sent to the renderer at all.
   */
  value: string | null
  /**
   * Where the winning value came from, e.g. `environments/demo.yml`; for a
   * value a Send set, which step: `set by login · tests`.
   */
  origin: string
  kind: VariableKind
}

export type VariablePreviews = Record<string, VariablePreview>

/**
 * What set a value as a run went: a step's `before.script` or `tests` with
 * `gta.set`, or a check capturing into it (`'setAsCollectionVariable'`).
 */
export type SetBy = 'pre-request' | 'tests' | 'captured'

/** A scope's source for a value set (`VariableScope.set`), as what set it. */
export const setByOf = (source: string): SetBy =>
  source === 'pre-request' || source === 'tests' ? source : 'captured'

/** Where a value a step set came from, as the editor says it: `set by login · tests`. */
export const setByText = (step: string, by: SetBy): string => `set by ${step} · ${by}`

const SET_CALL = /\bgta\.set\(\s*(['"`])([^'"`]+)\1/g
const CAPTURE = /(['"`])([^'"`\n]+)\1\s*,\s*(['"`])setAs(?:Collection|Environment)Variable\3/g

/**
 * The names a script sets as written: a literal `gta.set('name', …)`, and in
 * `tests` a check capturing into one, the name before its
 * `'setAsCollectionVariable'`. A name a script works out as it runs is not
 * known until it does.
 */
export function namesSetIn(
  script: string | undefined,
  phase: 'pre-request' | 'tests'
): Array<{ name: string; by: SetBy }> {
  if (!script) return []
  const set = [...script.matchAll(SET_CALL)].map((m) => ({ name: m[2]!, by: phase }))
  if (phase === 'pre-request') return set
  const captured = [...script.matchAll(CAPTURE)].map((m) => ({
    name: m[2]!,
    by: 'captured' as const
  }))
  return [...set, ...captured]
}

/**
 * The `{{names}}` a collection's steps set as they run, each by the first
 * step, in run order, to set it: setup, steps, teardown, then the
 * collection's own `tests`, which every step runs. A step is named as reports
 * name it: `setup › grant`. What tells a variable an earlier step sets, known
 * once it runs, from one nothing defines.
 */
export function namesStepsSet(
  collection: Pick<Collection, 'setup' | 'steps' | 'teardown' | 'tests'>
): Record<string, { step: string; by: SetBy }> {
  const found: Record<string, { step: string; by: SetBy }> = {}
  const add = (step: string, names: Array<{ name: string; by: SetBy }>) => {
    for (const { name, by } of names) found[name] ??= { step, by }
  }
  for (const stage of ['setup', 'steps', 'teardown'] as const) {
    for (const step of collection[stage] ?? []) {
      const name = `${stage === 'steps' ? '' : `${stage} › `}${stepLabel(step)}`
      add(name, namesSetIn(step.before?.script, 'pre-request'))
      add(name, namesSetIn(step.tests, 'tests'))
    }
  }
  add('the collection', namesSetIn(collection.tests, 'tests'))
  return found
}
