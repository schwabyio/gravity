/**
 * A worker thread's entry point: one collection, then exit.
 *
 * Each collection gets a thread of its own, so a script that never yields, or
 * leaves something behind in a global, costs that collection and nothing else
 * — and `timeoutCollection` can stop it outright.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { runJob, type CollectionJob } from './job.js'

parentPort!.postMessage(await runJob(workerData as CollectionJob))
