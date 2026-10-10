import { Worker } from 'node:worker_threads'
import { TEARDOWN_AFTER_STOP_MS } from '@schwabyio/gravity-core'
import { runJob, type CollectionJob, type JobOutcome } from './job.js'

/** How long past teardown's own limit a timed-out thread has to say how it went. */
const REPORT_MS = 5_000

/** Runs one collection job to an outcome. Never rejects. */
export type Runner = (job: CollectionJob) => Promise<JobOutcome>

/**
 * Run each job in a worker thread of its own, stopped after `timeoutMs`.
 *
 * At the limit its steps stop, and its teardown cleans up after them before
 * the thread goes (SPEC.md §2.10), for `TEARDOWN_AFTER_STOP_MS` at most. A
 * script that never yields holds the thread from hearing that, so it goes when
 * teardown's time is up whatever it is doing.
 *
 * `workerUrl` is the bundled `worker.js`; the entry point passes it, since only
 * it knows where the bundle landed.
 */
export function workerRunner(workerUrl: URL, timeoutMs: number): Runner {
  return (job) =>
    new Promise<JobOutcome>((resolve) => {
      const worker = new Worker(workerUrl, { workerData: job })
      const timedOut = `Timed out after ${timeoutMs} ms (timeoutCollection)`
      let late = false
      let settled = false
      let gone: NodeJS.Timeout | undefined
      const settle = (outcome: JobOutcome) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(gone)
        resolve(outcome)
        // Done or not, the thread goes: keep-alive sockets must not hold it open.
        void worker.terminate()
      }
      const timer = setTimeout(() => {
        late = true
        worker.postMessage({ type: 'timeout' })
        gone = setTimeout(
          () => settle({ ok: false, message: timedOut }),
          TEARDOWN_AFTER_STOP_MS + REPORT_MS
        )
      }, timeoutMs)
      worker.once('message', (outcome: JobOutcome) =>
        settle(late ? timedOutAfter(timedOut, outcome) : outcome)
      )
      worker.once('error', (error) => settle({ ok: false, message: error.message }))
      worker.once('exit', (code) =>
        settle({ ok: false, message: `The run stopped before it finished (exit code ${code})` })
      )
    })
}

/** A run stopped at its limit: a failure, saying how the teardown after it went, if one ran. */
export function timedOutAfter(message: string, outcome: JobOutcome): JobOutcome {
  const teardown = outcome.ok ? outcome.summary.results.filter((r) => r.stage === 'teardown') : []
  if (teardown.length === 0) return { ok: false, message }
  const passed = teardown.filter((result) => result.status === 'pass').length
  return {
    ok: false,
    message: `${message}. Teardown ran after it: ${passed} of ${teardown.length} passed.`
  }
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
