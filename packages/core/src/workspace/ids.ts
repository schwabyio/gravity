import path from 'node:path'
import { DOC_EXTENSION } from '../format/constants.js'
import type { Collection } from '../model/documents.js'
import { nameProblem, relativePosix } from '../paths.js'

/**
 * A collection file's `id` (SPEC.md §2): its file name without `.yml`, written
 * in the file, and unique within its home — `collections/`, `requests/`,
 * `bases/` or `endpoints/` — across the directories in it.
 *
 * Unique ignoring case, because macOS and Windows file systems ignore it: two
 * ids that differ only in case would be one file on a colleague's machine.
 *
 * Because an id is unique, it names a collection on its own — in `gta`'s
 * output, its reports, and on the command line — without the directory it sits
 * in.
 */

/** What an id may be: letters, digits and `- _ .`, as it is typed on a command line. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** The id a collection file must have: its file name without `.yml`. */
export const idOfFile = (file: string): string => path.basename(file, DOC_EXTENSION)

/** What is wrong with a file's `id`, or null when it is its file name. */
export function idProblem(doc: Pick<Collection, 'id'>, file: string): string | null {
  const expected = idOfFile(file)
  if (!ID_PATTERN.test(expected)) {
    return `${expected}${DOC_EXTENSION}: a collection's file name is its id, and an id is letters, digits and - _ . (SPEC.md §2)`
  }
  // Made on macOS or Linux, `aux.yml` loads; a Windows checkout cannot hold it.
  const unusable = nameProblem(path.basename(file))
  if (unusable) return `${path.basename(file)}: ${unusable} (SPEC.md §1.2)`
  if (doc.id === undefined) {
    return `id: missing — a collection file says its id, its file name: id: ${expected} (SPEC.md §2)`
  }
  if (doc.id !== expected) {
    return `id: ${doc.id} does not match the file name, ${expected}${DOC_EXTENSION} — they must be the same (SPEC.md §2)`
  }
  return null
}

/**
 * Files in one home whose ids collide, ignoring case, each with a problem
 * naming the others. `home` is the directory they are in: `collections/`.
 */
export function duplicateIds(files: readonly string[], home: string): Map<string, string> {
  const byId = new Map<string, string[]>()
  for (const file of files) {
    const key = idOfFile(file).toLowerCase()
    byId.set(key, [...(byId.get(key) ?? []), file])
  }
  const problems = new Map<string, string>()
  for (const group of byId.values()) {
    if (group.length < 2) continue
    for (const file of group) {
      const others = group
        .filter((other) => other !== file)
        .map((other) => `${path.basename(home)}/${relativePosix(home, other)}`)
      problems.set(
        file,
        `id: ${idOfFile(file)} is also the id of ${others.join(', ')} — an id is unique in ${path.basename(home)}/, ignoring case (SPEC.md §2)`
      )
    }
  }
  return problems
}
