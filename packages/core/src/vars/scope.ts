import { randomUUID } from 'node:crypto'
import type { FlagValue, VarValue } from '../model/documents.js'

/** A named set of variables, plus where it came from, for error messages. */
export interface VarLayer {
  source: string
  vars: Record<string, VarValue>
  /** Names this layer declared with `secret: true`. */
  secrets?: string[]
}

export class InterpolationError extends Error {
  constructor(
    message: string,
    /** The variable that could not be resolved, when there is one. */
    readonly variable?: string
  ) {
    super(message)
    this.name = 'InterpolationError'
  }
}

/**
 * The process environment, looked up by exact name.
 *
 * On Windows `process.env` ignores case, so `env.path` answers with `Path` and
 * `env.username` with `USERNAME`: a variable called `path` would be replaced by
 * the system's. Its entries keep each name as it is spelled, so a variable
 * means the same on every platform.
 */
export const exactEnv = (env: Record<string, string | undefined>): Map<string, string> =>
  new Map(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined))

/**
 * The variable scope for one run.
 *
 * Layers are merged lowest precedence first (SPEC.md §4):
 *
 *     collection -> folder -> environment -> before.script -> captures -> process env
 *
 * Process environment is applied last so CI can override anything, but **only for
 * names already declared by another layer**. Putting every ambient variable in
 * scope would leak `PATH`, `HOME` and everything else into request URLs, and make
 * a collection behave differently on two machines for reasons nothing documents.
 */
export class VariableScope {
  /**
   * The run's feature flag values (SPEC.md §2.9), for flag conditions and
   * `gta.flag`; null when none are known, so any flag named is unknown.
   */
  flags: Record<string, FlagValue> | null = null
  /**
   * Values that last the whole collection run, across its data rows and into
   * teardown (SPEC.md §2.10): where `gta.set(…, { scope: 'run' })` writes.
   * Null outside a collection run, where there is nothing to outlast.
   */
  runValues: Map<string, VarValue> | null = null
  /** In setup and teardown, every value set lasts the run. */
  runWide = false
  private readonly values = new Map<string, VarValue>()
  private readonly origins = new Map<string, string>()
  private readonly secrets = new Set<string>()

  constructor(layers: VarLayer[] = [], env: Record<string, string | undefined> = {}) {
    for (const layer of layers) {
      for (const [name, value] of Object.entries(layer.vars)) {
        this.values.set(name, value)
        this.origins.set(name, layer.source)
      }
      for (const name of layer.secrets ?? []) this.secrets.add(name)
    }
    const exact = exactEnv(env)
    for (const name of [...this.values.keys()]) {
      const override = exact.get(name)
      if (override !== undefined) {
        this.values.set(name, override)
        this.origins.set(name, 'process environment')
      }
    }
  }

  has(name: string): boolean {
    return this.values.has(name)
  }

  get(name: string): VarValue | undefined {
    return this.values.get(name)
  }

  /**
   * Declared with `secret: true`.
   *
   * Taken from the declaration rather than guessed from the name: a heuristic
   * would mask `authUrl` and miss `k8sKey`.
   */
  isSecret(name: string): boolean {
    return this.secrets.has(name)
  }

  /** Where a variable's winning value came from, for diagnostics. */
  originOf(name: string): string | undefined {
    return this.origins.get(name)
  }

  /** Record a value produced during the run: `gta.set`, or a capture. */
  set(name: string, value: VarValue, source = 'runtime'): void {
    this.values.set(name, value)
    this.origins.set(name, source)
    if (this.runWide) this.runValues?.set(name, value)
  }

  /** `set`, and keep the value for every row after this one and for teardown. */
  setForRun(name: string, value: VarValue, source = 'runtime'): void {
    this.set(name, value, source)
    this.runValues?.set(name, value)
  }

  names(): string[] {
    return [...this.values.keys()].sort()
  }

  /** A plain snapshot, for handing to a script sandbox or a report. */
  all(): Record<string, VarValue> {
    return Object.fromEntries(this.values)
  }
}

/**
 * Names a step has of its own over a run's scope, while it runs: a request
 * set's `params`, a `forEach` item. They shadow nothing else and are read only:
 * everything the step sets (`gta.set`, captures) goes to the run's scope
 * underneath, so the steps after it see it.
 */
export class OverlayScope extends VariableScope {
  constructor(
    private readonly run: VariableScope,
    private readonly own: Map<string, VarValue>,
    /** Where these names come from, for diagnostics. */
    private readonly origin: string
  ) {
    super()
    this.flags = run.flags
  }

  override has(name: string): boolean {
    return this.own.has(name) || this.run.has(name)
  }

  override get(name: string): VarValue | undefined {
    return this.own.has(name) ? this.own.get(name) : this.run.get(name)
  }

  override isSecret(name: string): boolean {
    return !this.own.has(name) && this.run.isSecret(name)
  }

  override originOf(name: string): string | undefined {
    return this.own.has(name) ? this.origin : this.run.originOf(name)
  }

  override set(name: string, value: VarValue, source = 'runtime'): void {
    this.run.set(name, value, source)
  }

  override setForRun(name: string, value: VarValue, source = 'runtime'): void {
    this.run.setForRun(name, value, source)
  }

  override names(): string[] {
    return [...new Set([...this.own.keys(), ...this.run.names()])].sort()
  }

  override all(): Record<string, VarValue> {
    return { ...this.run.all(), ...Object.fromEntries(this.own) }
  }
}

/**
 * A request set's `params` over a run's scope, while the set's requests run.
 * Params read as `params.<name>` — in a request `{{params.username}}` — and
 * that prefix is theirs alone.
 */
export class ParamsScope extends OverlayScope {
  constructor(run: VariableScope, params: Record<string, VarValue>) {
    super(
      run,
      new Map(Object.entries(params).map(([name, value]) => [`params.${name}`, value])),
      'params'
    )
  }
}

/**
 * Built-in dynamic variables, addressed as `{{$name}}`.
 *
 * Evaluated per reference, so two `{{$uuid}}` in one request are two uuids —
 * which is what you want for correlation ids, and why they are not cached.
 */
export const BUILT_INS: Record<string, () => string> = {
  $uuid: () => randomUUID(),
  $timestamp: () => String(Date.now()),
  $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1000))
}
