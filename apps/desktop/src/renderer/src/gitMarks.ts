import type { CollectionSummary } from '@schwabyio/gravity-core/model'
import type { ChangeKindView, ProjectView } from '@shared/ipc.js'

/**
 * What the sidebar marks a file or folder with, from git: changed since the
 * last commit, new and not committed yet, or in conflict. Pure, so the
 * sidebar and its tests agree on what a row says.
 */
export type GitMark = 'modified' | 'new' | 'conflicted'

const MARKS: Record<ChangeKindView, GitMark> = {
  modified: 'modified',
  typechange: 'modified',
  // A row only shows what is there; inside a folder, one gone is still a change to it.
  deleted: 'modified',
  added: 'new',
  untracked: 'new',
  renamed: 'new',
  copied: 'new',
  conflicted: 'conflicted'
}

/** What a mark says, in a letter and in words. */
export const MARK_LETTER: Record<GitMark, string> = { modified: 'M', new: 'U', conflicted: 'C' }
export const MARK_WORDS: Record<GitMark, string> = {
  modified: 'Changed since the last commit',
  new: 'New, not committed yet',
  conflicted: 'In conflict: resolve it in Changes'
}

/** A conflict outranks a change, which outranks something new. */
const RANK: Record<GitMark, number> = { conflicted: 3, modified: 2, new: 1 }

function strongest(kinds: Array<ChangeKindView | undefined>): GitMark | null {
  let mark: GitMark | null = null
  for (const kind of kinds) {
    const next = kind ? MARKS[kind] : null
    if (next && (!mark || RANK[next] > RANK[mark])) mark = next
  }
  return mark
}

/** A file's path from the project folder, with `/` — or null for one outside it. */
export function fromProject(projectPath: string, file: string): string | null {
  const root = `${projectPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`
  const target = file.replace(/\\/g, '/')
  return target.startsWith(root) ? target.slice(root.length) : null
}

export interface GitMarks {
  /** A file of the project, by its path. */
  file: (path: string) => GitMark | null
  /** A collection: its file, or its data file. */
  collection: (summary: CollectionSummary) => GitMark | null
  /** A folder of `collections/`: anything in it, gone or not. */
  folder: (name: string) => GitMark | null
}

/** The marks of one project's files, from its git state; none without git. */
export function gitMarks(project: Pick<ProjectView, 'path' | 'git'>): GitMarks {
  const files = project.git?.projectFiles ?? {}
  const of = (path: string) => {
    const relative = fromProject(project.path, path)
    return relative === null ? undefined : files[relative]
  }
  return {
    file: (path) => strongest([of(path)]),
    collection: (summary) =>
      strongest([
        of(summary.path),
        summary.dataFile ? files[`collections/${summary.dataFile.relativePath}`] : undefined
      ]),
    folder: (name) =>
      strongest(
        Object.entries(files)
          .filter(([relative]) => relative.startsWith(`collections/${name}/`))
          .map(([, kind]) => kind)
      )
  }
}
