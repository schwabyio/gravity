import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'

/**
 * Reading what a project holds, from a disk that does not always answer the
 * first time.
 *
 * On Windows, antivirus and the search indexer open each file just written —
 * every file of a fresh clone — and while one holds it, reading it, or the
 * folder it is in, fails: EBUSY, EPERM. Such a read is tried again a little
 * later, a few times. A folder or file that is not there is not there, as it
 * always was; one that is there and still cannot be read is an
 * `UnreadableError`, never an empty folder. An empty one would quietly drop
 * what is in it — a project's environments, say — until something happened to
 * read it again.
 */

/** Errors a moment later need not repeat. */
const PASSING = new Set(['EBUSY', 'EPERM', 'EACCES', 'EAGAIN', 'EMFILE', 'ENFILE', 'UNKNOWN'])

/** The waits before each try after the first: under a second in all. */
const RETRY_MS = [50, 200, 600]

/** What is not there: a folder that is not there is empty, a file has no text. */
const ABSENT = new Set(['ENOENT', 'ENOTDIR'])

/** A folder or file that is there, and could not be read however often it was tried. */
export class UnreadableError extends Error {
  /** Why, as a person reads it: `EBUSY: resource busy or locked`. */
  readonly reason: string

  constructor(
    readonly path: string,
    readonly code: string,
    cause: unknown
  ) {
    const said = cause instanceof Error ? cause.message : String(cause)
    // Node's message repeats the call and the path: the code and its words are the reason.
    const reason = /^(\w+: [^,]+)/.exec(said)?.[1] ?? code
    super(`Could not read ${path} (${reason})`, { cause })
    this.name = 'UnreadableError'
    this.reason = reason
  }
}

/** A read that took more than one try: what, why, how many tries, and whether one worked. */
export interface ReadRetry {
  path: string
  code: string
  tries: number
  read: boolean
}

let observer: ((retry: ReadRetry) => void) | null = null

/** Be told of every read that took more than one try: the desktop app's load log. */
export function observeReadRetries(listener: ((retry: ReadRetry) => void) | null): void {
  observer = listener
}

const codeOf = (cause: unknown): string =>
  (cause as NodeJS.ErrnoException | null)?.code ?? 'UNKNOWN'

async function tried<T>(target: string, read: () => Promise<T>): Promise<T> {
  let code = ''
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await read()
      if (attempt > 0) observer?.({ path: target, code, tries: attempt + 1, read: true })
      return result
    } catch (cause) {
      code = codeOf(cause)
      if (ABSENT.has(code)) throw cause
      const wait = RETRY_MS[attempt]
      if (!PASSING.has(code) || wait === undefined) {
        if (attempt > 0) observer?.({ path: target, code, tries: attempt + 1, read: false })
        throw new UnreadableError(target, code, cause)
      }
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** A folder's entries; none for a folder that is not there. */
export async function readFolder(directory: string): Promise<Dirent[]> {
  try {
    return await tried(directory, () => fs.readdir(directory, { withFileTypes: true }))
  } catch (cause) {
    if (ABSENT.has(codeOf(cause))) return []
    throw cause
  }
}

/** A file's text. One that is not there fails as it always did, with ENOENT. */
export function readText(file: string): Promise<string> {
  return tried(file, () => fs.readFile(file, 'utf8'))
}
