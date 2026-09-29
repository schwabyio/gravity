import path from 'node:path'
import { isGtaPath, isInside, relativePosix, type GitFileChange } from '@schwabyio/gravity-core'
import type { ChangedFileView } from '../shared/ipc.js'

/** More changed files than this are not listed: the rest is a terminal's job. */
export const MAX_LISTED_CHANGES = 5000

/** `.env`, `.env.local` — secret values, never meant to be committed (SPEC.md §1). */
const SECRET = /^\.env(\..+)?$/
const SECRET_TEMPLATE = /\.(example|sample|template)$/

export const isSecretFile = (name: string) => SECRET.test(name) && !SECRET_TEMPLATE.test(name)

/** A folder whose changes are grouped together: an app project, or a global project it uses. */
export interface OwnerRoot {
  id: string
  path: string
}

/**
 * Which project each changed file belongs to, and whether it starts checked.
 *
 * Every changed file in the repository is listed, so nothing is committed
 * blind. What starts checked is only gta's own files in a project — its
 * collections, environments and the like — never a service's source code
 * sharing the folder, and never a secret.
 */
export function classifyChanges(
  repoRoot: string,
  files: GitFileChange[],
  roots: OwnerRoot[]
): { files: ChangedFileView[]; truncated: boolean } {
  // Deepest first, so a project nested in another's folder owns its own files.
  const byDepth = [...roots].sort((a, b) => b.path.length - a.path.length)
  const listed = files.slice(0, MAX_LISTED_CHANGES).map((file): ChangedFileView => {
    const absolute = path.join(repoRoot, ...file.path.split('/'))
    const owner = byDepth.find((root) => isInside(root.path, absolute)) ?? null
    const secret = isSecretFile(path.posix.basename(file.path))
    const gta = owner !== null && isGtaPath(relativePosix(owner.path, absolute))
    return {
      path: file.path,
      origPath: file.origPath,
      kind: file.kind,
      staged: file.staged,
      submodule: file.submodule,
      projectId: owner?.id ?? null,
      checkedByDefault: gta && !secret && file.kind !== 'conflicted' && !file.submodule,
      secret
    }
  })
  return { files: listed, truncated: files.length > MAX_LISTED_CHANGES }
}
