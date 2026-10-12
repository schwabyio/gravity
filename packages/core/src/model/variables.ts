/**
 * Variable preview types.
 *
 * These live in the model rather than beside the resolver because the renderer
 * needs them, and the model entry point is the one it can import without
 * dragging the filesystem into a sandboxed bundle.
 */
import {
  isUseStep,
  readParam,
  stepLabel,
  type Collection,
  type ParamSpec,
  type UseStep
} from './documents.js'

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

/**
 * A value a script sets, as written: by its name, or in a reusable requests
 * file by the param holding the name (`gta.set(params.saveAs, …)`), which the
 * use step running the file chooses.
 */
export type Setter = { by: SetBy } & ({ name: string } | { param: string })

const SET_CALL = /\bgta\.set\(\s*(?:(['"`])([^'"`]+)\1|params\.([A-Za-z_$][\w$]*))/g
const CAPTURE =
  /(?:(['"`])([^'"`\n]+)\1|\bparams\.([A-Za-z_$][\w$]*))\s*,\s*(['"`])setAs(?:Collection|Environment)Variable\4/g

/**
 * What a script sets as written: `gta.set('name', …)`, and in `tests` a check
 * capturing into a name, the one before its `'setAsCollectionVariable'` —
 * either a name in quotes or `params.name`. A name a script works out any
 * other way is not known until it runs.
 */
export function settersIn(script: string | undefined, phase: 'pre-request' | 'tests'): Setter[] {
  if (!script) return []
  const setter = (match: RegExpMatchArray, by: SetBy): Setter =>
    match[2] !== undefined ? { name: match[2], by } : { param: match[3]!, by }
  const set = [...script.matchAll(SET_CALL)].map((match) => setter(match, phase))
  if (phase === 'pre-request') return set
  return [...set, ...[...script.matchAll(CAPTURE)].map((match) => setter(match, 'captured'))]
}

/** The names a script sets in quotes (`settersIn`). */
export function namesSetIn(
  script: string | undefined,
  phase: 'pre-request' | 'tests'
): Array<{ name: string; by: SetBy }> {
  return settersIn(script, phase).flatMap((setter) =>
    'name' in setter ? [{ name: setter.name, by: setter.by }] : []
  )
}

/** What a reusable requests file sets: by one of its steps, named; or by its own scripts (`null`), which run with each. */
export type FileSetter = Setter & { step: string | null }

/** Everything a reusable requests file's scripts set, its own first. */
export function fileSetters(file: Pick<Collection, 'steps' | 'before' | 'tests'>): FileSetter[] {
  const of = (step: string | null, before: string | undefined, tests: string | undefined) =>
    [...settersIn(before, 'pre-request'), ...settersIn(tests, 'tests')].map(
      (setter): FileSetter => ({ ...setter, step })
    )
  return [
    ...of(null, file.before?.script, file.tests),
    ...file.steps.flatMap((step) => of(stepLabel(step), step.before?.script, step.tests))
  ]
}

/** A reusable requests file as `namesStepsSet` needs it. */
export interface UsedFile {
  params: Record<string, ParamSpec>
  /** How many steps it has, to name one as reports do. */
  steps: number
  setters: FileSetter[]
}

/** The name a param holds, when it is one: given by the use step, or the param's default. */
function paramName(use: UseStep, file: UsedFile, param: string): string | null {
  const spec = file.params[param]
  if (spec === undefined) return null
  const value = use.with?.[param] ?? readParam(spec).default
  return typeof value === 'string' && value !== '' && !value.includes('{{') ? value : null
}

/** What a use step's file sets, by its steps as reports name a use step's results (`resultName`). */
function usedFileSets(
  use: UseStep,
  file: UsedFile
): Array<[step: string, names: Array<{ name: string; by: SetBy }>]> {
  const named = use.name?.trim() ? use.name : null
  return file.setters.flatMap((setter) => {
    const name = 'name' in setter ? setter.name : paramName(use, file, setter.param)
    if (name === null) return []
    const step =
      setter.step === null
        ? stepLabel(use)
        : !named
          ? setter.step
          : file.steps === 1
            ? named
            : `${named} › ${setter.step}`
    return [[step, [{ name, by: setter.by }]]]
  })
}

/**
 * The `{{names}}` a collection's steps set as they run, each by the first
 * step, in run order, to set it: setup, steps, teardown — a use step's
 * reusable requests file among them, its `params` names read from its `with:`
 * — then the collection's own `tests`, which every step runs. A step is named
 * as reports name it: `setup › grant`, `sign in › create token`. What tells a
 * variable an earlier step sets, known once it runs, from one nothing defines.
 */
export function namesStepsSet(
  collection: Pick<Collection, 'setup' | 'steps' | 'teardown' | 'tests'>,
  /** The reusable requests file a use step names, when it can be found. */
  fileOf: (reference: string) => UsedFile | null = () => null
): Record<string, { step: string; by: SetBy }> {
  const found: Record<string, { step: string; by: SetBy }> = {}
  const add = (step: string, names: Array<{ name: string; by: SetBy }>) => {
    for (const { name, by } of names) found[name] ??= { step, by }
  }
  for (const stage of ['setup', 'steps', 'teardown'] as const) {
    const prefix = stage === 'steps' ? '' : `${stage} › `
    for (const step of collection[stage] ?? []) {
      const name = `${prefix}${stepLabel(step)}`
      add(name, namesSetIn(step.before?.script, 'pre-request'))
      const file = isUseStep(step) ? fileOf(step.use) : null
      if (file && isUseStep(step)) {
        for (const [by, names] of usedFileSets(step, file)) add(`${prefix}${by}`, names)
      }
      add(name, namesSetIn(step.tests, 'tests'))
    }
  }
  add('the collection', namesSetIn(collection.tests, 'tests'))
  return found
}
