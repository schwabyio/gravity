import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseCheckAttr, parseLsFilesEol, type StoredEol } from './attributes.js'
import {
  addedFileDiff,
  MAX_DIFF_BYTES,
  MAX_DIFF_LINES,
  parseNumstat,
  parseUnifiedDiff,
  type FileDiff
} from './diff.js'
import { GitCommandError, gitMessage } from './errors.js'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  parseBranches,
  parseLog,
  type BranchInfo,
  type CommitInfo
} from './log.js'
import { nameProblem } from '../paths.js'
import { runGit, type GitResult, type RunGitOptions } from './runGit.js'
import { parseStatus, STATUS_ARGS, type GitFileChange, type GitStatus } from './status.js'

/** Something git is in the middle of, which has to be finished before anything else. */
export type GitOperation = 'merge' | 'rebase' | 'am' | 'cherry-pick' | 'revert'

export type PullOutcome = 'up-to-date' | 'fast-forward' | 'rebased'

/** Paths go to git through a file or stdin, NUL-separated: no quoting, no length limit. */
const nul = (paths: string[]) => paths.map((file) => `${file}\0`).join('')

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * A git working tree.
 *
 * Everything funnels through `runGit`, and nothing above this module builds git
 * command lines. Every command that takes file paths treats them literally
 * (`--literal-pathspecs`): a file named `[draft].yml` is that file, not a glob.
 *
 * Operations that change the repository throw `GitCommandError` — git's message
 * plus a hint — rather than return a status, so a failure cannot be mistaken
 * for success.
 */
export class GitRepo {
  private constructor(
    /** Absolute path to the working-tree root. */
    readonly root: string,
    /**
     * Absolute path to the git directory.
     *
     * Not always `<root>/.git`: in a worktree or a submodule `.git` is a file
     * pointing elsewhere, which is why this is resolved by git rather than joined.
     */
    readonly gitDir: string
  ) {}

  /** Open the repository containing `dir`, or null when it is not in one. */
  static async open(dir: string): Promise<GitRepo | null> {
    const result = await runGit(['rev-parse', '--show-toplevel', '--absolute-git-dir'], {
      cwd: dir
    })
    if (result.code !== 0) return null
    const [root, gitDir] = result.stdout.trim().split(/\r?\n/)
    if (!root || !gitDir) return null
    return new GitRepo(path.resolve(root), path.resolve(gitDir))
  }

  private run(args: string[], options?: Partial<RunGitOptions>): Promise<GitResult> {
    return runGit(args, { cwd: this.root, ...options })
  }

  /** Run, and throw git's message when it fails. */
  private async must(
    args: string[],
    fallback: string,
    options?: Partial<RunGitOptions>
  ): Promise<GitResult> {
    const result = await this.run(args, options)
    if (result.code !== 0) throw GitCommandError.from(result, fallback)
    return result
  }

  /** A path git reports (repo-relative, `/`) as an absolute one. */
  absolute(repoPath: string): string {
    return path.join(this.root, ...repoPath.split('/'))
  }

  async status(): Promise<GitStatus> {
    const result = await this.run(STATUS_ARGS)
    return parseStatus(result.stdout)
  }

  /**
   * Files matching a pathspec, tracked or untracked but never ignored.
   *
   * This is how collections are discovered: it is near-instant even on a large
   * monorepo and skips `node_modules` and anything else `.gitignore` covers,
   * without us maintaining an ignore list.
   */
  async listFiles(pathspec: string): Promise<string[]> {
    const result = await this.run([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      pathspec
    ])
    if (result.code !== 0) return []
    return result.stdout.split('\0').filter((entry) => entry !== '')
  }

  /** A merge, rebase or the like left in progress, or null. */
  async operation(): Promise<GitOperation | null> {
    const has = (name: string) =>
      fs.stat(path.join(this.gitDir, name)).then(
        () => true,
        () => false
      )
    if (await has('rebase-merge')) return 'rebase'
    if (await has('rebase-apply')) return (await has('rebase-apply/applying')) ? 'am' : 'rebase'
    if (await has('MERGE_HEAD')) return 'merge'
    if (await has('CHERRY_PICK_HEAD')) return 'cherry-pick'
    if (await has('REVERT_HEAD')) return 'revert'
    return null
  }

  async remotes(): Promise<string[]> {
    const result = await this.run(['remote'])
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '')
  }

  private async config(key: string): Promise<string | null> {
    const result = await this.run(['config', '--get', key])
    return result.code === 0 ? result.stdout.trim() || null : null
  }

  /** Refuse to change a repository that is mid-merge, mid-rebase or conflicted. */
  private async refuseDuringOperation(status: GitStatus, action: string): Promise<void> {
    const operation = await this.operation()
    if (operation) {
      throw GitCommandError.refused(
        `Cannot ${action}: a ${operation} is in progress in this repository.`,
        'Finish or abort it in your git tool, then try again.'
      )
    }
    if (status.conflicted > 0) {
      throw GitCommandError.refused(
        `Cannot ${action}: this repository has unresolved conflicts.`,
        'Resolve them in your git tool, then try again.'
      )
    }
  }

  /* -------------------------------------------------------------- identity -- */

  /** The name and email a commit here would carry, or null for what is not set. */
  async identity(): Promise<{ name: string | null; email: string | null }> {
    const env = process.env
    return {
      name:
        (await this.config('user.name')) ??
        env['GIT_AUTHOR_NAME'] ??
        env['GIT_COMMITTER_NAME'] ??
        null,
      email:
        (await this.config('user.email')) ??
        env['GIT_AUTHOR_EMAIL'] ??
        env['GIT_COMMITTER_EMAIL'] ??
        env['EMAIL'] ??
        null
    }
  }

  /** Save a name and email in the global git config, as `git config --global` would. */
  async setIdentity(name: string, email: string): Promise<void> {
    await this.must(['config', '--global', 'user.name', name.trim()], 'Could not save your name')
    await this.must(['config', '--global', 'user.email', email.trim()], 'Could not save your email')
  }

  /* ---------------------------------------------------------------- commit -- */

  /**
   * Commit these paths as they are on disk, and nothing else.
   *
   * `--only` commits exactly the given paths; whatever else is staged — from a
   * terminal, say — stays staged and out of this commit. New files are added
   * first, since `--only` takes only paths git already knows. Hooks run and
   * signing happens as the person's config says.
   */
  async commit(paths: string[], message: string): Promise<{ oid: string; shortOid: string }> {
    if (paths.length === 0) throw GitCommandError.refused('Choose at least one file to commit.')
    if (message.trim() === '') throw GitCommandError.refused('Write a commit message first.')
    const status = await this.status()
    await this.refuseDuringOperation(status, 'commit')
    if (status.detached) {
      throw GitCommandError.refused(
        'Cannot commit on a detached HEAD.',
        'Create a branch first, so the commit is not lost.'
      )
    }

    const selected = new Set(paths)
    const added = status.files
      .filter((file) => file.kind === 'untracked' && selected.has(file.path))
      .map((file) => file.path)
    if (added.length > 0) {
      await this.must(
        ['--literal-pathspecs', 'add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        'Could not add the new files',
        { input: nul(added) }
      )
    }

    const result = await withPathspecFile(paths, (file) =>
      this.run(
        [
          '--literal-pathspecs',
          'commit',
          '--only',
          '--quiet',
          '-F',
          '-',
          `--pathspec-from-file=${file}`,
          '--pathspec-file-nul'
        ],
        // Hooks can take a while.
        { input: message, timeout: 600_000 }
      )
    )
    const head = await this.run(['rev-parse', '--verify', '--quiet', 'HEAD'])
    const after = head.code === 0 ? head.stdout.trim() : null
    if (result.code !== 0 && (after === null || after === status.headOid)) {
      // Put the new files back as they were: untracked.
      if (added.length > 0) {
        await this.run(
          [
            '--literal-pathspecs',
            'rm',
            '--cached',
            '--quiet',
            '--ignore-unmatch',
            '--pathspec-from-file=-',
            '--pathspec-file-nul'
          ],
          { input: nul(added) }
        )
      }
      throw GitCommandError.from(result, 'The commit failed')
    }
    return { oid: after!, shortOid: after!.slice(0, 7) }
  }

  /* --------------------------------------------------------------- discard -- */

  /**
   * Put a file back as the last commit has it — or, for a new file, remove it.
   *
   * The version on disk goes to `moveAside` first (the desktop app passes the
   * Trash), so a discard can be undone. If that fails, nothing is changed.
   */
  async discard(
    file: GitFileChange,
    moveAside: (absolute: string) => Promise<void>
  ): Promise<void> {
    const status = await this.status()
    await this.refuseDuringOperation(status, 'discard changes')
    if (file.submodule) {
      throw GitCommandError.refused('Discarding changes in a submodule is not supported here.')
    }

    const absolute = this.absolute(file.path)
    const onDisk = await fs.lstat(absolute).then(
      () => true,
      () => false
    )
    if (onDisk) await moveAside(absolute)
    if (file.kind === 'untracked') return

    if (status.unborn) {
      await this.must(
        ['--literal-pathspecs', 'rm', '--cached', '--quiet', '--ignore-unmatch', '--', file.path],
        'Could not discard the change'
      )
      return
    }
    await this.must(
      [
        '--literal-pathspecs',
        'restore',
        '--source=HEAD',
        '--staged',
        '--worktree',
        '--',
        file.path,
        ...(file.origPath ? [file.origPath] : [])
      ],
      'Could not discard the change'
    )
  }

  /* ------------------------------------------------------------------ diff -- */

  /**
   * A file's text as the last commit has it (repo-relative path, `/`), or
   * null when it has none: a new file, or a branch with no commits yet.
   */
  async committed(repoPath: string): Promise<string | null> {
    const result = await this.run(['show', '--no-textconv', `HEAD:${repoPath}`])
    return result.code === 0 ? result.stdout : null
  }

  /** What changed in one file since the last commit: staged and unstaged together. */
  async diff(file: GitFileChange): Promise<FileDiff> {
    const base = { path: file.path, origPath: file.origPath }
    const status = await this.status()

    // A file with no earlier version: all of it is new.
    if (file.kind === 'untracked' || (status.unborn && file.kind !== 'deleted')) {
      const absolute = this.absolute(file.path)
      const stat = await fs.stat(absolute).catch(() => null)
      if (!stat || !stat.isFile()) return { ...base, binary: false, tooLarge: false, hunks: [] }
      if (stat.size > MAX_DIFF_BYTES) return { ...base, binary: false, tooLarge: true, hunks: [] }
      return { ...base, tooLarge: false, ...addedFileDiff(await fs.readFile(absolute)) }
    }
    if (status.unborn) return { ...base, binary: false, tooLarge: false, hunks: [] }

    const paths = ['--', file.path, ...(file.origPath ? [file.origPath] : [])]
    const flags = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']
    const numstat = await this.must(
      ['--literal-pathspecs', 'diff', '--numstat', '-z', ...flags, 'HEAD', ...paths],
      'Could not read the change'
    )
    const size = parseNumstat(numstat.stdout)
    if (size.binary) return { ...base, binary: true, tooLarge: false, hunks: [] }
    if (size.changedLines > MAX_DIFF_LINES) {
      return { ...base, binary: false, tooLarge: true, hunks: [] }
    }
    const result = await this.must(
      [
        '--literal-pathspecs',
        'diff',
        ...flags,
        '-U3',
        '--submodule=short',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        'HEAD',
        ...paths
      ],
      'Could not read the change'
    )
    return { ...base, tooLarge: false, ...parseUnifiedDiff(result.stdout) }
  }

  /* ------------------------------------------------------------------- log -- */

  /** The branch's recent commits, newest first, each marked pushed or not. */
  async log(options: { max?: number; skip?: number } = {}): Promise<{
    commits: CommitInfo[]
    hasMore: boolean
  }> {
    const max = options.max ?? 50
    const skip = options.skip ?? 0
    const status = await this.status()
    if (status.unborn) return { commits: [], hasMore: false }

    const result = await this.must(
      [
        'log',
        '--no-color',
        '--no-show-signature',
        `--max-count=${max + 1}`,
        `--skip=${skip}`,
        LOG_FORMAT,
        'HEAD',
        '--'
      ],
      'Could not read the history'
    )
    const limit = `--max-count=${skip + max + 1}`
    const unpushed = await this.run(
      status.upstream && !status.upstreamGone
        ? ['rev-list', limit, '@{upstream}..HEAD']
        : ['rev-list', limit, 'HEAD', '--not', '--remotes']
    )
    const commits = parseLog(
      result.stdout,
      new Set(unpushed.stdout.split(/\r?\n/).filter((line) => line !== ''))
    )
    return { commits: commits.slice(0, max), hasMore: commits.length > max }
  }

  /* -------------------------------------------------------------- branches -- */

  async branches(): Promise<{ branches: BranchInfo[]; remotes: string[] }> {
    const remotes = await this.remotes()
    const result = await this.must(
      ['for-each-ref', '--sort=-committerdate', BRANCH_FORMAT, 'refs/heads', 'refs/remotes'],
      'Could not list the branches'
    )
    return { branches: parseBranches(result.stdout, remotes), remotes }
  }

  /** Why `name` cannot be a new branch, or null when it can. */
  async branchNameProblem(name: string): Promise<string | null> {
    const trimmed = name.trim()
    if (trimmed === '') return 'A branch needs a name'
    if (trimmed.startsWith('-')) return 'A branch name cannot start with -'
    if (trimmed === '@' || trimmed === 'HEAD' || trimmed.includes('@{')) {
      return `"${trimmed}" means something else to git`
    }
    const valid = await this.run(['check-ref-format', '--branch', trimmed])
    if (valid.code !== 0) return `"${trimmed}" is not a valid branch name`
    const exists = await this.run(['show-ref', '--verify', '--quiet', `refs/heads/${trimmed}`])
    if (exists.code === 0) return `A branch named ${trimmed} already exists`
    return null
  }

  /** A new branch from where you are, switched to. Uncommitted changes come along. */
  async createBranch(name: string): Promise<void> {
    const problem = await this.branchNameProblem(name)
    if (problem) throw GitCommandError.refused(problem)
    const status = await this.status()
    await this.refuseDuringOperation(status, 'create a branch')
    if (status.unborn) {
      // No commit to branch from: the branch not yet made just gets this name.
      await this.must(
        ['symbolic-ref', 'HEAD', `refs/heads/${name.trim()}`],
        'Could not create the branch'
      )
      return
    }
    await this.must(['switch', '--quiet', '-c', name.trim()], 'Could not create the branch')
  }

  /**
   * Switch to a local branch, or to a remote one as a new local branch that
   * tracks it. Uncommitted changes come along when git can carry them; when it
   * cannot, git refuses and says why — nothing is stashed or forced.
   */
  async switchBranch(name: string, remote?: string | null): Promise<void> {
    // A name is only ever a branch: never read as an option.
    const ref = remote ? `refs/remotes/${remote}/${name}` : `refs/heads/${name}`
    const exists = await this.run(['show-ref', '--verify', '--quiet', ref])
    if (name.startsWith('-') || remote?.startsWith('-') || exists.code !== 0) {
      throw GitCommandError.refused(`There is no branch ${remote ? `${remote}/` : ''}${name}.`)
    }
    const status = await this.status()
    await this.refuseDuringOperation(status, 'switch branches')
    await this.must(
      remote
        ? ['switch', '--quiet', '-c', name, '--track', `refs/remotes/${remote}/${name}`]
        : ['switch', '--quiet', '--no-guess', name],
      `Could not switch to ${name}`
    )
  }

  /* --------------------------------------------------------------- network -- */

  /** Update the remote-tracking branches, dropping those deleted on the remote. */
  async fetch(options: { interactive?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    await this.must(['fetch', '--quiet', '--prune'], 'The fetch failed', {
      timeout: 300_000,
      network: { interactive: options.interactive ?? true },
      ...(options.signal ? { signal: options.signal } : {})
    })
  }

  /**
   * Bring in the upstream's new commits.
   *
   * Spelled out rather than `git pull`, so the person's `pull.rebase` or
   * `pull.ff` config cannot change what happens:
   *
   * - nothing new: nothing happens;
   * - only theirs: fast-forward, even with local changes (git refuses if any
   *   would be overwritten);
   * - both moved on: replay yours on top (rebase), with no changes of your own
   *   left uncommitted. If that conflicts it is undone, and the repository is
   *   exactly as it was.
   */
  async pull(): Promise<{ outcome: PullOutcome; message: string }> {
    let status = await this.status()
    await this.refuseDuringOperation(status, 'pull')
    if (status.detached) throw GitCommandError.refused('Cannot pull on a detached HEAD.')
    if (status.unborn) throw GitCommandError.refused('Cannot pull before the first commit.')
    const branch = status.branch!
    if (!status.upstream) {
      throw GitCommandError.refused(
        `${branch} has no upstream branch to pull from.`,
        'Push it first to publish it.'
      )
    }
    const remote = await this.config(`branch.${branch}.remote`)
    await this.must(
      ['fetch', '--quiet', '--prune', ...(remote && remote !== '.' ? [remote] : [])],
      'The fetch failed',
      {
        timeout: 300_000,
        network: { interactive: true }
      }
    )

    status = await this.status()
    if (status.upstreamGone) {
      throw GitCommandError.refused(`${status.upstream} is gone from the remote.`)
    }
    const ahead = status.ahead ?? 0
    const behind = status.behind ?? 0
    if (behind === 0) return { outcome: 'up-to-date', message: 'Already up to date.' }

    if (ahead === 0) {
      await this.must(['merge', '--ff-only', '--quiet', '@{upstream}'], 'The pull failed')
      return { outcome: 'fast-forward', message: `Pulled ${plural(behind, 'commit')}.` }
    }

    if (status.files.some((file) => file.kind !== 'untracked')) {
      throw GitCommandError.refused(
        `Your branch and ${status.upstream} have both moved on, and you have uncommitted changes.`,
        'Commit or discard them, then pull again.'
      )
    }
    const merges = await this.run(['rev-list', '--merges', '--count', '@{upstream}..HEAD'])
    if (Number(merges.stdout.trim()) > 0) {
      throw GitCommandError.refused(
        'Your unpushed commits include a merge, which a rebase would flatten.',
        'Pull in your git tool instead.'
      )
    }

    const before = status.headOid
    const result = await this.run(
      ['-c', 'rebase.updateRefs=false', 'rebase', '--no-autostash', '@{upstream}'],
      { timeout: 600_000 }
    )
    if (result.code === 0) {
      return {
        outcome: 'rebased',
        message: `Replayed your ${plural(ahead, 'commit')} on top of ${plural(behind, 'new commit')} from ${status.upstream}.`
      }
    }

    const conflicted = await this.run(['diff', '--name-only', '-z', '--diff-filter=U'])
    const conflicts = conflicted.stdout.split('\0').filter((file) => file !== '')
    if ((await this.operation()) === 'rebase') await this.run(['rebase', '--abort'])
    const head = await this.run(['rev-parse', 'HEAD'])
    if (head.stdout.trim() !== before || (await this.operation())) {
      throw new GitCommandError(
        `The rebase stopped and could not be undone: ${gitMessage(result)}`,
        {
          kind: 'conflict',
          hint: 'Finish or abort it in your git tool (git rebase --abort).',
          stderr: result.stderr,
          conflicts
        }
      )
    }
    throw new GitCommandError(
      conflicts.length > 0
        ? `Your commits conflict with ${status.upstream} in ${conflicts.join(', ')}. Nothing was changed.`
        : `The rebase failed, and nothing was changed: ${gitMessage(result)}`,
      {
        kind: 'conflict',
        hint: 'Resolve it in your git tool with git pull --rebase.',
        stderr: result.stderr,
        conflicts
      }
    )
  }

  /**
   * Push the current branch: to its upstream, or — the first time — publish it
   * to a remote and make that its upstream. Never forced.
   */
  async push(options: { remote?: string | null } = {}): Promise<{ message: string }> {
    const status = await this.status()
    await this.refuseDuringOperation(status, 'push')
    if (status.detached) throw GitCommandError.refused('Cannot push a detached HEAD.')
    if (status.unborn) throw GitCommandError.refused('Nothing to push yet: make a first commit.')
    const branch = status.branch!
    const remotes = await this.remotes()
    if (remotes.length === 0) {
      throw GitCommandError.refused('This repository has no remote to push to.')
    }

    let args: string[]
    let target: string
    if (status.upstream && !status.upstreamGone) {
      const remote = await this.config(`branch.${branch}.remote`)
      const merge = await this.config(`branch.${branch}.merge`)
      if (!remote || remote === '.' || !merge) {
        throw GitCommandError.refused(
          `${branch} tracks ${status.upstream}, which is not on a remote.`
        )
      }
      args = ['push', '--porcelain', remote, `refs/heads/${branch}:${merge}`]
      target = status.upstream
    } else {
      const remote =
        options.remote ??
        (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0]! : null)
      if (!remote) throw GitCommandError.refused('Choose the remote to publish this branch to.')
      if (!remotes.includes(remote))
        throw GitCommandError.refused(`There is no remote named ${remote}.`)
      args = [
        'push',
        '--porcelain',
        '--set-upstream',
        remote,
        `refs/heads/${branch}:refs/heads/${branch}`
      ]
      target = `${remote}/${branch}`
    }

    const result = await this.run(args, { timeout: 600_000, network: { interactive: true } })
    const rejected = result.stdout.split(/\r?\n/).find((line) => line.startsWith('!\t'))
    if (result.code !== 0) {
      if (rejected) {
        const reason = rejected.split('\t')[2] ?? ''
        throw new GitCommandError(`${target} refused the push: ${reason}`, {
          stderr: `${result.stdout}\n${result.stderr}`
        })
      }
      throw GitCommandError.from(result, 'The push failed')
    }
    const upToDate = result.stdout.split(/\r?\n/).some((line) => line.startsWith('=\t'))
    return {
      message: upToDate
        ? `${target} is already up to date.`
        : status.upstream && !status.upstreamGone
          ? `Pushed ${branch} to ${target}.`
          : `Published ${branch} to ${target}.`
    }
  }

  /* ------------------------------------------------------- line endings -- */

  /** Attribute values git would apply to each path; the paths need not exist. */
  async attributes(paths: string[], names: string[]): Promise<Map<string, Record<string, string>>> {
    const result = await this.must(
      ['check-attr', '-z', '--stdin', ...names],
      'Could not read attributes',
      {
        input: nul(paths)
      }
    )
    return parseCheckAttr(result.stdout)
  }

  /** How tracked files under these pathspecs are stored: LF, CRLF or mixed. */
  async storedLineEndings(pathspecs: string[]): Promise<StoredEol[]> {
    const result = await this.run([
      '--literal-pathspecs',
      'ls-files',
      '--eol',
      '-z',
      '--',
      ...pathspecs
    ])
    return result.code === 0 ? parseLsFilesEol(result.stdout) : []
  }
}

/** Run with the paths in a temporary NUL-separated file, when stdin is taken. */
async function withPathspecFile<T>(paths: string[], use: (file: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-git-'))
  const file = path.join(dir, 'pathspec')
  try {
    await fs.writeFile(file, nul(paths))
    return await use(file)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

/** Clone a repository, returning the directory it landed in. */
export async function clone(
  url: string,
  parentDir: string,
  options: { directoryName?: string; onProgress?: (line: string) => void } = {}
): Promise<string> {
  const name = options.directoryName ?? defaultCloneName(url)
  // Refused everywhere, as the app refuses such names for every folder it makes:
  // on Windows git would fail on it, less clearly.
  const unusable = nameProblem(name)
  if (unusable) throw new Error(`Cannot clone into "${name}": ${unusable}`)
  const target = path.join(parentDir, name)
  const result = await runGit(['clone', '--progress', '--', url, target], {
    cwd: parentDir,
    timeout: 1_800_000,
    network: { interactive: true },
    ...(options.onProgress ? { onProgress: options.onProgress } : {})
  })
  if (result.code !== 0) throw GitCommandError.from(result, 'git clone failed')
  return target
}

/**
 * `git@host:org/repo.git`, `https://host/org/repo.git` and a Windows path
 * `C:\\repos\\repo` all give `repo`.
 */
export function defaultCloneName(url: string): string {
  const trimmed = url.replace(/\/+$/, '').replace(/\.git$/, '')
  const lastSegment = trimmed.split(/[/:\\]/).pop() ?? 'repository'
  return lastSegment === '' ? 'repository' : lastSegment
}
