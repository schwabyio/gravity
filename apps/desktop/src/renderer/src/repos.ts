import type { GitStatusView, ProjectView } from '@shared/ipc.js'

/** What of a project says which repository it is in, and that repository's state. */
export type RepoProject = Pick<ProjectView, 'id' | 'repoRoot' | 'git' | 'gitNote' | 'busy'>

/**
 * One repository of a workspace, shown once however many of its projects the
 * workspace holds: a monorepo's services share its branch, its changes and its
 * Fetch, Pull and Push.
 */
export interface RepoView<P extends RepoProject = ProjectView> {
  /** Its root, as main gives it: the same for each of its projects. */
  root: string
  /** The repository folder's name. */
  name: string
  /** Its projects in the workspace, in the sidebar's order. */
  projects: P[]
  /**
   * Its git state: the latest any of its projects read, as each is read again
   * when its own folder changes. Null when git could not say, and `gitNote` why.
   */
  git: GitStatusView | null
  gitNote: string | null
  /** A git operation is running in it. */
  busy: boolean
}

/** One entry of the sidebar: a project on its own, or a repository its projects sit under. */
export type SidebarEntry<P extends RepoProject = ProjectView> =
  { kind: 'project'; project: P } | { kind: 'repo'; repo: RepoView<P> }

/** A root compared: `/` for `\`, no trailing slash. git gives each project the same spelling. */
const rootKey = (root: string) => root.replace(/\\/g, '/').replace(/\/+$/, '')

/** The last folder of a path, on any platform. */
const folderName = (root: string) => rootKey(root).split('/').pop() || root

/**
 * The repositories the workspace's projects are in, each once, in the order
 * their first project is listed. A scratch pad, or a project outside git, is in none.
 */
export function repositories<P extends RepoProject>(projects: P[]): RepoView<P>[] {
  const byRoot = new Map<string, RepoView<P>>()
  for (const project of projects) {
    if (!project.repoRoot) continue
    const key = rootKey(project.repoRoot)
    const repo = byRoot.get(key)
    if (!repo) {
      byRoot.set(key, {
        root: project.repoRoot,
        name: folderName(project.repoRoot),
        projects: [project],
        git: project.git,
        gitNote: project.gitNote,
        busy: project.busy
      })
      continue
    }
    repo.projects.push(project)
    if (project.git && (!repo.git || project.git.read > repo.git.read)) repo.git = project.git
    repo.gitNote ??= project.gitNote
    repo.busy ||= project.busy
  }
  return [...byRoot.values()]
}

/**
 * The sidebar's entries: a repository that two or more of the workspace's
 * projects are in, where the first of them is listed, with those projects under
 * it; every other project on its own, where it is.
 */
export function sidebarEntries<P extends RepoProject>(projects: P[]): SidebarEntry<P>[] {
  const shared = new Map(
    repositories(projects)
      .filter((repo) => repo.projects.length > 1)
      .map((repo) => [rootKey(repo.root), repo])
  )
  const entries: SidebarEntry<P>[] = []
  const placed = new Set<RepoView<P>>()
  for (const project of projects) {
    const repo = project.repoRoot ? shared.get(rootKey(project.repoRoot)) : undefined
    if (!repo) entries.push({ kind: 'project', project })
    else if (!placed.has(repo)) {
      placed.add(repo)
      entries.push({ kind: 'repo', repo })
    }
  }
  return entries
}

/**
 * The repository the status bar names: the open collection's, or with none —
 * or one outside git — the workspace's only repository. Null where there is no
 * one to name.
 */
export function currentRepo<P extends RepoProject>(
  repos: RepoView<P>[],
  open: RepoProject | null | undefined
): RepoView<P> | null {
  const root = open?.repoRoot
  const own = root ? repos.find((repo) => rootKey(repo.root) === rootKey(root)) : undefined
  return own ?? (repos.length === 1 ? repos[0]! : null)
}
