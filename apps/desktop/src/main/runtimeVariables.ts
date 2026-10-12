import {
  redact,
  resultName,
  setByOf,
  setByText,
  type CarriedValue,
  type RunResult,
  type SetBy,
  type SetValue,
  type VarValue
} from '@schwabyio/gravity-core'
import type { RuntimeVariablesView } from '../shared/ipc.js'

/** A value a Send or run set, as the worker tells main of it and main keeps it. */
export interface KeptValue {
  name: string
  value: VarValue
  /**
   * The value as the app may show it: with any secret's value in it as
   * `[secret: NAME]`, as a request is shown. Null for a variable declared
   * secret, whatever it was set to.
   */
  shown: string | null
  /** The step that set it, as reports name it: `setup › grant`. */
  step: string
  by: SetBy
  /** The data row it was set in, when Run all ran every row: `row 2`. */
  row?: string
}

const textOf = (value: VarValue): string => (value === null ? 'null' : String(value))

/**
 * What a run sets, each value by the step that set it.
 *
 * Steps run one at a time and each reports its result when it is done, so
 * whatever was set since the last result was set by the step this one is of —
 * its scripts, the collection's around them and its checks' captures.
 */
export function stepRecorder(secrets: ReadonlyArray<[string, string]>) {
  const declared = new Set(secrets.map(([name]) => name))
  let pending: SetValue[] = []
  return {
    onSet: (set: SetValue) => {
      pending.push(set)
    },
    /** What was set since the last result, by the step `result` is of. */
    take(result: RunResult, iteration?: { index: number }): KeptValue[] {
      const taken = pending
      pending = []
      const step = resultName(result)
      return taken.map(({ name, value, source }) => ({
        name,
        value,
        shown: declared.has(name) ? null : redact(textOf(value), secrets),
        step,
        by: setByOf(source),
        ...(iteration ? { row: `row ${iteration.index}` } : {})
      }))
    }
  }
}

interface Kept {
  environment: string | null
  last: 'send' | 'run'
  at: number
  /** By name, in the order they were first set. */
  values: Map<string, KeptValue>
}

/**
 * What each collection's Sends and runs set, which its next Sends start from,
 * as the steps of one run share what they set.
 *
 * Kept by collection file until Clear or the app quits. Run all starts from
 * nothing, as gta does, and what it sets is kept after it. They belong to the
 * environment they were set in: asked for in another, they are forgotten, so
 * switching environments clears them.
 */
export class RuntimeVariables {
  private readonly kept = new Map<string, Kept>()
  private readonly listeners = new Set<(collectionPath: string) => void>()

  /** A collection's kept values changed: started, added to or cleared. */
  onChange(listener: (collectionPath: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private tell(collectionPath: string): void {
    for (const listener of this.listeners) listener(collectionPath)
  }

  /** What is kept for a collection in `environment`; another environment's is forgotten. */
  private keptIn(collectionPath: string, environment: string | null): Kept | null {
    const kept = this.kept.get(collectionPath)
    if (kept && kept.environment !== environment) {
      this.kept.delete(collectionPath)
      this.tell(collectionPath)
      return null
    }
    return kept ?? null
  }

  /** What a Send in `environment` starts from. */
  carried(collectionPath: string, environment: string | null): CarriedValue[] {
    const kept = this.keptIn(collectionPath, environment)
    return [...(kept?.values.values() ?? [])].map((value) => ({
      name: value.name,
      value: value.value,
      source: setByText(value.step, value.by),
      // The editor shows none of a value that holds a secret's.
      secret: value.shown !== textOf(value.value)
    }))
  }

  /** A Send or Run all of a collection starts: Run all forgets what came before. */
  begin(collectionPath: string, environment: string | null, last: 'send' | 'run'): void {
    const kept = last === 'send' ? this.keptIn(collectionPath, environment) : null
    this.kept.set(collectionPath, {
      environment,
      last,
      at: Date.now(),
      values: kept?.values ?? new Map()
    })
    this.tell(collectionPath)
  }

  /** Values a Send or run of a collection set, the last one set of a name winning. */
  add(collectionPath: string, values: KeptValue[]): void {
    const kept = this.kept.get(collectionPath)
    if (!kept || values.length === 0) return
    for (const value of values) kept.values.set(value.name, value)
    kept.at = Date.now()
    this.tell(collectionPath)
  }

  clear(collectionPath: string): void {
    if (this.kept.delete(collectionPath)) this.tell(collectionPath)
  }

  /** What the Variables tab shows for a collection in `environment`; null for nothing kept. */
  view(collectionPath: string, environment: string | null): RuntimeVariablesView | null {
    return this.keptIn(collectionPath, environment) && this.current(collectionPath)
  }

  /** What is kept for a collection now, in whichever environment it was set. */
  current(collectionPath: string): RuntimeVariablesView | null {
    const kept = this.kept.get(collectionPath)
    if (!kept) return null
    return {
      collectionPath,
      environment: kept.environment,
      last: kept.last,
      at: kept.at,
      variables: [...kept.values.values()].map(({ name, shown, step, by, row }) => ({
        name,
        value: shown,
        step,
        by,
        ...(row ? { row } : {})
      }))
    }
  }
}

export const runtimeVariables = new RuntimeVariables()
