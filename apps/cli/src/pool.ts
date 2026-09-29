import { Worker } from 'node:worker_threads'
import { runJob, type CollectionJob, type JobOutcome } from './job.js'

/** Runs one collection job to an outcome. Never rejects. */
export type Runner = (job: CollectionJob) => Promise<JobOutcome>

/**
 * Run each job in a worker thread of its own, stopped after `timeoutMs`.
 *
 * `workerUrl` is the bundled `worker.js`; the entry point passes it, since only
 * it knows where the bundle landed.
 */
export function workerRunner(workerUrl: URL, timeoutMs: number): Runner {
  return (job) =>
    new Promise<JobOutcome>((resolve) => {
      const worker = new Worker(workerUrl, { workerData: job })
      let settled = false
      const settle = (outcome: JobOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(outcome)
        // Done or not, the thread goes: keep-alive sockets must not hold it open.
        void worker.terminate()
      }
      const timer = setTimeout(
        () => settle({ ok: false, message: `Timed out after ${timeoutMs} ms (timeoutCollection)` }),
        timeoutMs
      )
      worker.once('message', (outcome: JobOutcome) => settle(outcome))
      worker.once('error', (error) => settle({ ok: false, message: error.message }))
      worker.once('exit', (code) =>
        settle({ ok: false, message: `The run stopped before it finished (exit code ${code})` })
      )
    })
}

/** Run each job in this thread: for tests, where there is no bundled worker. */
export const inProcessRunner: Runner = runJob

/**
 * Call `run` on each item, at most `limit` at a time, starting them in list
 * order. They finish in whatever order they complete.
 */
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  const lane = async () => {
    while (next < items.length) await run(items[next++]!)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}
