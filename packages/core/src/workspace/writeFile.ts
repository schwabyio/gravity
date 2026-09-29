import fs from 'node:fs/promises'
import path from 'node:path'
import { renameWithRetry } from '../paths.js'

export type EditOutcome =
  | { ok: true; source: string; wrote: boolean }
  /** The file is not the one the edits were made against; nothing was written. */
  | { ok: false; conflict: true; source: string }

/**
 * Write a file's new text, safely.
 *
 * - **Only against what was edited.** `baseSource` is the text the edits were made
 *   against. If the file on disk has changed since — a `git pull`, another editor —
 *   nothing is written and the disk text comes back, so the caller can show the
 *   change instead of silently overwriting it.
 * - **None at all** when the result is byte-identical.
 * - **Atomically**, via a temporary file and a rename, so a watcher or `git`
 *   never sees a half-written file.
 */
export async function writeIfUnchanged(
  file: string,
  baseSource: string,
  edit: (source: string) => string
): Promise<EditOutcome> {
  const source = await fs.readFile(file, 'utf8')
  if (source !== baseSource) return { ok: false, conflict: true, source }

  const next = edit(source)
  if (next === source) return { ok: true, source, wrote: false }

  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  await fs.writeFile(temporary, next)
  try {
    await renameWithRetry(temporary, file)
  } catch (cause) {
    await fs.rm(temporary, { force: true })
    throw cause
  }
  return { ok: true, source: next, wrote: true }
}
