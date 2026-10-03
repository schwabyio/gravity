import path from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { CollectionRunSummary, RunResult } from '@schwabyio/gravity-core'
import type { Vars } from '@schwabyio/gravity-core'
import type {
  ConnectionView,
  DataRowInput,
  EnvironmentOverride,
  IterationRef,
  LiveStream
} from '../shared/ipc.js'

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
  /** Steps run on their own: they use, and leave open, the connections Sends hold. */
  keepConnections?: boolean
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
  | { type: 'live'; runId: string; live: LiveStream }
  | { type: 'connections'; collectionPath: string; connections: ConnectionView[] }

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

  private readonly liveListeners = new Set<(runId: string, live: LiveStream) => void>()
  private readonly connectionListeners = new Set<
    (collectionPath: string, connections: ConnectionView[]) => void
  >()
  /** Collections whose Sends hold connections, so a worker that dies can say they are gone. */
  private readonly holding = new Set<string>()

  onProgress(
    listener: (runId: string, index: number, result: RunResult, iteration?: IterationRef) => void
  ): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  /** An event stream a run is reading, as it is read. */
  onLive(listener: (runId: string, live: LiveStream) => void): () => void {
    this.liveListeners.add(listener)
    return () => this.liveListeners.delete(listener)
  }

  /** The connections a collection's Sends hold, after each change. */
  onConnections(
    listener: (collectionPath: string, connections: ConnectionView[]) => void
  ): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  private reportConnections(collectionPath: string, connections: ConnectionView[]): void {
    if (connections.length > 0) this.holding.add(collectionPath)
    else this.holding.delete(collectionPath)
    for (const listener of this.connectionListeners) listener(collectionPath, connections)
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
      if (message.type === 'live') {
        for (const listener of this.liveListeners) listener(message.runId, message.live)
        return
      }
      if (message.type === 'connections') {
        this.reportConnections(message.collectionPath, message.connections)
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
      // Its connections went with it.
      for (const collectionPath of [...this.holding]) this.reportConnections(collectionPath, [])
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

  /** Stop reading the event stream a run is reading: a normal end, unlike Cancel. */
  stop(runId: string): void {
    this.worker?.postMessage({ type: 'stop', runId })
  }

  /** Close a connection a collection's Sends hold, or with no name all of them. */
  closeConnection(collectionPath: string, name?: string): void {
    this.worker?.postMessage({ type: 'closeConnection', collectionPath, name })
  }

  dispose(): void {
    this.worker?.kill()
    this.worker = null
    this.pending.clear()
    this.progressListeners.clear()
    this.liveListeners.clear()
    this.connectionListeners.clear()
  }
}

export const runSupervisor = new RunSupervisor()
