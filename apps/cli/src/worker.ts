/**
 * A worker thread's entry point: one collection, then exit.
 *
 * Each collection gets a thread of its own, so a script that never yields, or
 * leaves something behind in a global, costs that collection and nothing else
 * — and `timeoutCollection` can stop it outright, once its teardown has had
 * its time to clean up (pool.ts).
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runJob, type CollectionJob } from './job.js'

// timeoutCollection, from the pool: the steps stop, and teardown cleans up after them.
const timeout = new AbortController()
parentPort!.on('message', (message: { type?: string } | null) => {
  if (message?.type === 'timeout') timeout.abort()
})
parentPort!.postMessage(await runJob(workerData as CollectionJob, { signal: timeout.signal }))
