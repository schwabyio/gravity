import path from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { CollectionRunSummary, RunResult } from '@schwabyio/gravity-core'
import type { Vars } from '@schwabyio/gravity-core'
import type { DataRowInput, EnvironmentOverride, IterationRef } from '../shared/ipc.js'

/** How a run resolves its variables: the environment chosen, and anything edited but unsaved. */
export interface RunOptions {
  environment?: string | null
  environmentOverrides?: EnvironmentOverride[]
  projectVars?: Vars | null | undefined
  /** The feature flag values to run with (SPEC.md §2.9); null for none known. */
  flags?: Record<string, string | number | boolean> | null
  /** The data file row to run with; null for none; absent, the file's first row. */
  dataRow?: DataRowInput | null
  /** Every row, for a collection run that iterates them (SPEC.md §2.8). */
  dataRows?: DataRowInput[]
}

type WorkerMessage =
  | { type: 'result'; runId: string; result: RunResult }
  | { type: 'summary'; runId: string; summary: CollectionRunSummary }
  | {
      type: 'progress'
      runId: string
      index: number
      result: RunResult
      iteration?: IterationRef
    }
  | { type: 'failure'; runId: string; message: string }

interface Pending {
  resolve: (value: never) => void
  reject: (error: Error) => void
}

/**
 * Owns the run worker and routes requests to it by id.
 *
 * The worker is forked on first use and respawned if it dies, so a crash costs
 * one run rather than the session. The same supervisor shape is what the CLI
 * will implement over `worker_threads`.
 */
class RunSupervisor {
  private worker: UtilityProcess | null = null
  private readonly pending = new Map<string, Pending>()
  private readonly progressListeners = new Set<
    (runId: string, index: number, result: RunResult, iteration?: IterationRef) => void
  >()

  onProgress(
    listener: (runId: string, index: number, result: RunResult, iteration?: IterationRef) => void
  ): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker

    const entry = path.join(__dirname, 'runWorker.js')
    const worker = utilityProcess.fork(entry, [], { serviceName: 'api-run-worker' })

    worker.on('message', (message: WorkerMessage) => {
      // Progress is not a completion: it fires many times per run.
      if (message.type === 'progress') {
        for (const listener of this.progressListeners) {
          listener(message.runId, message.index, message.result, message.iteration)
        }
        return
      }
      const waiting = this.pending.get(message.runId)
      if (!waiting) return
      this.pending.delete(message.runId)
      if (message.type === 'result') waiting.resolve(message.result as never)
      else if (message.type === 'summary') waiting.resolve(message.summary as never)
      else waiting.reject(new Error(message.message))
    })

    worker.on('exit', (code) => {
      this.worker = null
      const reason = new Error(`Run worker exited unexpectedly (code ${code})`)
      for (const waiting of this.pending.values()) waiting.reject(reason)
      this.pending.clear()
    })

    this.worker = worker
    return worker
  }

  run(
    runId: string,
    step: unknown,
    collection: unknown,
    collectionPath: string | null = null,
    options: RunOptions = {}
  ): Promise<RunResult> {
    const worker = this.ensureWorker()
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(runId, { resolve: resolve as never, reject })
      worker.postMessage({
        type: 'run',
        runId,
        step,
        collection,
        collectionPath,
        ...options
      })
    })
  }

  /** Run a whole collection; per-step results arrive through `onProgress`. */
  runCollection(
    runId: string,
    collection: unknown,
    collectionPath: string | null,
    options: RunOptions = {}
  ): Promise<CollectionRunSummary> {
    const worker = this.ensureWorker()
    return new Promise<CollectionRunSummary>((resolve, reject) => {
      this.pending.set(runId, { resolve: resolve as never, reject })
      worker.postMessage({
        type: 'runCollection',
        runId,
        collection,
        collectionPath,
        ...options
      })
    })
  }

  cancel(runId: string): void {
    this.worker?.postMessage({ type: 'cancel', runId })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = null
    this.pending.clear()
    this.progressListeners.clear()
  }
}

export const runSupervisor = new RunSupervisor()
