import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitCommandError } from './errors.js'
import { clone, GitRepo } from './repo.js'
import { resetGitRuntime } from './runGit.js'
import type { GitFileChange } from './status.js'
import { bareRemote, cloneOf, commitAll, git, isolateGit, tempDir, write } from './testing.js'

/**
 * Every operation against real repositories: a bare remote, the repository the
 * app works in, and another clone standing in for a colleague.
 */

let tmp: string
let globalConfig: string

beforeEach(async () => {
  tmp = await tempDir('gravity-repo-')
  ;({ globalConfig } = await isolateGit(tmp))
})

afterEach(async () => {
  resetGitRuntime()
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 3 })
})

async function setup() {
  const remote = await bareRemote(path.join(tmp, 'remote.git'))
  const work = path.join(tmp, 'work')
  await write(path.join(work, 'a.yml'), 'a: 1\n')
  await write(path.join(work, 'b.yml'), 'b: 1\n')
  await git(tmp, 'init', '--quiet', work)
  await commitAll(work, 'first')
  await git(work, 'remote', 'add', 'origin', remote)
  await git(work, 'push', '--quiet', '-u', 'origin', 'main')
  const other = await cloneOf(remote, path.join(tmp, 'other'))
  const repo = (await GitRepo.open(work))!
  return { remote, work, other, repo }
}

const file = async (repo: GitRepo, repoPath: string): Promise<GitFileChange> => {
  const found = (await repo.status()).files.find((change) => change.path === repoPath)
  if (!found) throw new Error(`${repoPath} is not changed`)
  return found
}

const lastCommit = (dir: string) => git(dir, 'show', '--name-status', '-M', '--format=%s', 'HEAD')
const staged = (dir: string) => git(dir, 'diff', '--cached', '--name-only')
const head = async (dir: string) => (await git(dir, 'rev-parse', 'HEAD')).trim()

/** A commit in `other`, pushed: the remote moves on without us. */
async function theyPush(other: string, name: string, body: string) {
  await write(path.join(other, name), body)
  await commitAll(other, `theirs: ${name}`)
  await git(other, 'push', '--quiet')
}

describe('commit', () => {
  it('commits only the chosen files, and leaves what was staged elsewhere staged', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: 2\n')
    await write(path.join(work, 'b.yml'), 'b: 2\n')
    await git(work, 'add', 'b.yml')
    await write(path.join(work, 'c.yml'), 'c: 1\n')

    const { shortOid } = await repo.commit(['a.yml', 'c.yml'], 'Update a, add c')
    expect(shortOid).toHaveLength(7)
    expect(await lastCommit(work)).toBe('Update a, add c\n\nM\ta.yml\nA\tc.yml\n')
    expect(await staged(work)).toBe('b.yml\n')
  })

  it('commits a rename given both of its paths', async () => {
    const { work, repo } = await setup()
    await git(work, 'mv', 'a.yml', 'renamed.yml')
    const change = await file(repo, 'renamed.yml')
    expect(change).toMatchObject({ kind: 'renamed', origPath: 'a.yml' })

    await repo.commit(['renamed.yml', 'a.yml'], 'Rename')
    expect(await lastCommit(work)).toBe('Rename\n\nR100\ta.yml\trenamed.yml\n')
    expect(await staged(work)).toBe('')
  })

  it('commits a deletion, staged or not', async () => {
    const { work, repo } = await setup()
    await fs.rm(path.join(work, 'a.yml'))
    await git(work, 'rm', '--quiet', 'b.yml')
    await repo.commit(['a.yml', 'b.yml'], 'Remove both')
    expect(await lastCommit(work)).toBe('Remove both\n\nD\ta.yml\nD\tb.yml\n')
  })

  it('takes paths literally: [x].yml is not a pattern matching x.yml', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'x.yml'), 'x: 1\n')
    await write(path.join(work, '[x].yml'), 'bracket: 1\n')
    await repo.commit(['[x].yml'], 'Only the bracketed one')
    expect(await lastCommit(work)).toBe('Only the bracketed one\n\nA\t[x].yml\n')
    expect((await repo.status()).files.map((change) => change.path)).toEqual(['x.yml'])
  })

  it('makes the first commit of a new repository, and names its branch', async () => {
    const fresh = path.join(tmp, 'fresh')
    await git(tmp, 'init', '--quiet', fresh)
    await write(path.join(fresh, 'one.yml'), 'one: 1\n')
    await write(path.join(fresh, 'two.yml'), 'two: 1\n')
    const repo = (await GitRepo.open(fresh))!
    expect((await repo.status()).unborn).toBe(true)

    await repo.createBranch('trunk')
    expect((await repo.status()).branch).toBe('trunk')
    await repo.commit(['one.yml'], 'First')
    const status = await repo.status()
    expect(status).toMatchObject({ unborn: false, branch: 'trunk' })
    expect(status.files.map((change) => [change.path, change.kind])).toEqual([
      ['two.yml', 'untracked']
    ])
  })

  it('puts new files back as untracked when the commit fails', async () => {
    const { work, repo } = await setup()
    await write(
      path.join(work, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\necho "no commits today" >&2\nexit 1\n'
    )
    await fs.chmod(path.join(work, '.git', 'hooks', 'pre-commit'), 0o755)
    await write(path.join(work, 'new.yml'), 'new: 1\n')

    const failure = await repo.commit(['new.yml'], 'Blocked').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(GitCommandError)
    expect((failure as GitCommandError).message).toContain('no commits today')
    expect((await file(repo, 'new.yml')).kind).toBe('untracked')
  })

  it('refuses during a merge, and on a detached HEAD', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'a.yml', 'a: theirs\n')
    await write(path.join(work, 'a.yml'), 'a: mine\n')
    await commitAll(work, 'mine')
    await git(work, 'fetch', '--quiet')
    await git(work, 'merge', '--quiet', 'origin/main').catch(() => undefined)
    expect(await repo.operation()).toBe('merge')
    await expect(repo.commit(['a.yml'], 'x')).rejects.toMatchObject({ kind: 'refused' })

    await git(work, 'merge', '--abort')
    await git(work, 'switch', '--quiet', '--detach', 'HEAD')
    await write(path.join(work, 'b.yml'), 'b: 3\n')
    await expect(repo.commit(['b.yml'], 'x')).rejects.toThrow(/detached/)
  })
})

describe('committed', () => {
  it('reads a file as the last commit has it, edits on disk or not, and null for a new one', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: 2\n')
    await write(path.join(work, 'c.yml'), 'c: 1\n')
    expect(await repo.committed('a.yml')).toBe('a: 1\n')
    expect(await repo.committed('c.yml')).toBeNull()
    expect(await repo.committed('nope/missing.yml')).toBeNull()
  })
})

describe('identity', () => {
  it('knows when name and email are missing, and saves them globally', async () => {
    const { repo } = await setup()
    await fs.writeFile(
      globalConfig,
      '[user]\n\tuseConfigOnly = true\n[commit]\n\tgpgsign = false\n'
    )
    const saved = { ...process.env }
    for (const key of [
      'GIT_AUTHOR_NAME',
      'GIT_COMMITTER_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_EMAIL',
      'EMAIL'
    ]) {
      delete process.env[key]
    }
    try {
      expect(await repo.identity()).toEqual({ name: null, email: null })
      await repo.setIdentity(' Ann Example ', 'ann@example.test')
      expect(await repo.identity()).toEqual({ name: 'Ann Example', email: 'ann@example.test' })
      expect(await fs.readFile(globalConfig, 'utf8')).toContain('ann@example.test')
    } finally {
      process.env = saved
    }
  })
})

describe('discard', () => {
  const trash: string[] = []
  const moveAside = async (absolute: string) => {
    trash.push(absolute)
    await fs.rm(absolute, { force: true })
  }
  beforeEach(() => void trash.splice(0))

  it('puts back modified, staged, added, deleted and renamed files, and removes new ones', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: 2\n')
    await git(work, 'add', 'a.yml')
    await write(path.join(work, 'a.yml'), 'a: 3\n')
    await fs.rm(path.join(work, 'b.yml'))
    await write(path.join(work, 'added.yml'), 'added: 1\n')
    await git(work, 'add', 'added.yml')
    await write(path.join(work, 'loose.yml'), 'loose: 1\n')

    for (const repoPath of ['a.yml', 'b.yml', 'added.yml', 'loose.yml']) {
      await repo.discard(await file(repo, repoPath), moveAside)
    }
    expect((await repo.status()).files).toEqual([])
    expect(await fs.readFile(path.join(work, 'a.yml'), 'utf8')).toBe('a: 1\n')
    expect(await fs.readFile(path.join(work, 'b.yml'), 'utf8')).toBe('b: 1\n')
    // What was on disk went aside first; a deleted file had nothing to move.
    expect(trash.map((file) => path.basename(file)).sort()).toEqual([
      'a.yml',
      'added.yml',
      'loose.yml'
    ])

    await git(work, 'mv', 'a.yml', 'moved.yml')
    await repo.discard(await file(repo, 'moved.yml'), moveAside)
    expect((await repo.status()).files).toEqual([])
    expect(await fs.readFile(path.join(work, 'a.yml'), 'utf8')).toBe('a: 1\n')
  })

  it('changes nothing when the file cannot be moved aside', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: 2\n')
    await expect(
      repo.discard(await file(repo, 'a.yml'), () => Promise.reject(new Error('no trash')))
    ).rejects.toThrow('no trash')
    expect(await fs.readFile(path.join(work, 'a.yml'), 'utf8')).toBe('a: 2\n')
  })
})

describe('diff', () => {
  it('shows a modified file as numbered hunks', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: 2\nextra: true')
    const diff = await repo.diff(await file(repo, 'a.yml'))
    expect(diff.binary).toBe(false)
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'a: 1', oldLine: 1, newLine: null },
      { kind: 'add', text: 'a: 2', oldLine: null, newLine: 1 },
      { kind: 'add', text: 'extra: true', oldLine: null, newLine: 2 },
      { kind: 'meta', text: 'No newline at end of file', oldLine: null, newLine: null }
    ])
  })

  it('shows a new file as all added, and a deleted one as all removed', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'new.yml'), 'one\ntwo\n')
    const added = await repo.diff(await file(repo, 'new.yml'))
    expect(added.hunks[0]!.lines.map((line) => [line.kind, line.text, line.newLine])).toEqual([
      ['add', 'one', 1],
      ['add', 'two', 2]
    ])

    await fs.rm(path.join(work, 'b.yml'))
    const removed = await repo.diff(await file(repo, 'b.yml'))
    expect(removed.hunks[0]!.lines).toEqual([
      { kind: 'del', text: 'b: 1', oldLine: 1, newLine: null }
    ])
  })

  it('knows a binary file, and one too large to show', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]))
    expect((await repo.diff(await file(repo, 'image.png'))).binary).toBe(true)
    await commitAll(work, 'image')
    await write(path.join(work, 'image.png'), Buffer.from([0x89, 0x50, 0x00, 0x02]))
    expect((await repo.diff(await file(repo, 'image.png'))).binary).toBe(true)

    await write(
      path.join(work, 'a.yml'),
      Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n')
    )
    expect((await repo.diff(await file(repo, 'a.yml'))).tooLarge).toBe(true)
  })
})

describe('branches', () => {
  it('lists local branches, and remote ones not checked out yet', async () => {
    const { work, other, repo } = await setup()
    await git(other, 'switch', '--quiet', '-c', 'feature/theirs')
    await write(path.join(other, 'f.yml'), 'f: 1\n')
    await commitAll(other, 'f')
    await git(other, 'push', '--quiet', '-u', 'origin', 'feature/theirs')
    await repo.fetch()

    const { branches, remotes } = await repo.branches()
    expect(remotes).toEqual(['origin'])
    expect(branches.map((b) => [b.name, b.remote, b.current])).toEqual(
      expect.arrayContaining([
        ['main', null, true],
        ['feature/theirs', 'origin', false]
      ])
    )
    expect(branches.filter((b) => b.name === 'main')).toHaveLength(1)

    await repo.switchBranch('feature/theirs', 'origin')
    const status = await repo.status()
    expect(status).toMatchObject({ branch: 'feature/theirs', upstream: 'origin/feature/theirs' })
    expect(await fs.readFile(path.join(work, 'f.yml'), 'utf8')).toBe('f: 1\n')
  })

  it('creates a branch, carrying uncommitted changes along', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'a.yml'), 'a: wip\n')
    await repo.createBranch('feature/x')
    const status = await repo.status()
    expect(status.branch).toBe('feature/x')
    expect(status.files.map((change) => change.path)).toEqual(['a.yml'])
    await repo.switchBranch('main')
    expect((await repo.status()).branch).toBe('main')
  })

  it('refuses names git would not take, or already has', async () => {
    const { repo } = await setup()
    expect(await repo.branchNameProblem('main')).toMatch(/already exists/)
    expect(await repo.branchNameProblem('bad..name')).toMatch(/not a valid/)
    expect(await repo.branchNameProblem('-x')).toMatch(/cannot start/)
    expect(await repo.branchNameProblem('@')).toMatch(/something else/)
    expect(await repo.branchNameProblem('a b')).toMatch(/not a valid/)
    expect(await repo.branchNameProblem('feature/ok-1.2')).toBeNull()
  })

  it('passes on git refusing a switch that would lose changes', async () => {
    const { work, repo } = await setup()
    await repo.createBranch('other')
    await write(path.join(work, 'a.yml'), 'a: on other\n')
    await commitAll(work, 'other')
    await git(work, 'switch', '--quiet', 'main')
    await write(path.join(work, 'a.yml'), 'a: wip on main\n')
    await expect(repo.switchBranch('other')).rejects.toMatchObject({ kind: 'dirty' })
  })
})

describe('push', () => {
  it('publishes a new branch, then pushes to it', async () => {
    const { work, remote, repo } = await setup()
    await repo.createBranch('feature/p')
    await write(path.join(work, 'p.yml'), 'p: 1\n')
    await repo.commit(['p.yml'], 'p')
    expect((await repo.push()).message).toBe('Published feature/p to origin/feature/p.')
    expect((await repo.status()).upstream).toBe('origin/feature/p')

    await write(path.join(work, 'p.yml'), 'p: 2\n')
    await repo.commit(['p.yml'], 'p again')
    expect((await repo.push()).message).toBe('Pushed feature/p to origin/feature/p.')
    expect((await git(remote, 'rev-parse', 'feature/p')).trim()).toBe(await head(work))
  })

  it('never forces: a remote that moved on refuses, with the hint to pull', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'theirs.yml', 'x: 1\n')
    await write(path.join(work, 'mine.yml'), 'y: 1\n')
    await repo.commit(['mine.yml'], 'mine')
    const failure = (await repo.push().catch((error: unknown) => error)) as GitCommandError
    expect(failure).toBeInstanceOf(GitCommandError)
    expect(failure.kind).toBe('rejected')
    expect(failure.hint).toMatch(/Pull/)
  })
})

describe('pull', () => {
  it('says so when there is nothing new', async () => {
    const { repo } = await setup()
    expect(await repo.pull()).toMatchObject({ outcome: 'up-to-date' })
  })

  it('fast-forwards, even with an unrelated change of your own', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'theirs.yml', 'x: 1\n')
    await write(path.join(work, 'a.yml'), 'a: wip\n')
    expect(await repo.pull()).toMatchObject({
      outcome: 'fast-forward',
      message: 'Pulled 1 commit.'
    })
    expect(await fs.readFile(path.join(work, 'theirs.yml'), 'utf8')).toBe('x: 1\n')
    expect(await fs.readFile(path.join(work, 'a.yml'), 'utf8')).toBe('a: wip\n')
  })

  it('replays your commits on top of theirs when both moved on', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'theirs.yml', 'x: 1\n')
    await write(path.join(work, 'mine.yml'), 'y: 1\n')
    await repo.commit(['mine.yml'], 'mine')
    expect(await repo.pull()).toMatchObject({ outcome: 'rebased' })
    const log = await git(work, 'log', '--format=%s')
    expect(log).toBe('mine\ntheirs: theirs.yml\nfirst\n')
    expect(await git(work, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0\n')
  })

  it('undoes a rebase that conflicts, leaving everything as it was', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'a.yml', 'a: theirs\n')
    await write(path.join(work, 'a.yml'), 'a: mine\n')
    await repo.commit(['a.yml'], 'mine')
    const before = await head(work)

    const failure = (await repo.pull().catch((error: unknown) => error)) as GitCommandError
    expect(failure).toBeInstanceOf(GitCommandError)
    expect(failure.kind).toBe('conflict')
    expect(failure.conflicts).toEqual(['a.yml'])
    expect(failure.message).toMatch(/Nothing was changed/)
    expect(await head(work)).toBe(before)
    expect(await repo.operation()).toBeNull()
    expect((await repo.status()).files).toEqual([])
    expect(await fs.readFile(path.join(work, 'a.yml'), 'utf8')).toBe('a: mine\n')
  })

  it('will not rebase over uncommitted changes', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'theirs.yml', 'x: 1\n')
    await write(path.join(work, 'mine.yml'), 'y: 1\n')
    await repo.commit(['mine.yml'], 'mine')
    await write(path.join(work, 'a.yml'), 'a: wip\n')
    await expect(repo.pull()).rejects.toMatchObject({ kind: 'refused' })
  })
})

describe('fetch and history', () => {
  it('sees the remote move on, and marks commits not pushed yet', async () => {
    const { work, other, repo } = await setup()
    await theyPush(other, 'theirs.yml', 'x: 1\n')
    await repo.fetch({ interactive: false })
    expect((await repo.status()).behind).toBe(1)

    await write(path.join(work, 'mine.yml'), 'y: 1\n')
    await repo.commit(['mine.yml'], 'mine')
    const { commits, hasMore } = await repo.log()
    expect(hasMore).toBe(false)
    expect(commits.map((commit) => [commit.subject, commit.pushed, commit.author])).toEqual([
      ['mine', false, 'Test'],
      ['first', true, 'Test']
    ])
    expect((await repo.log({ max: 1 })).hasMore).toBe(true)
  })
})

describe('line endings', () => {
  it('finds files stored with CRLF, and what .gitattributes says about them', async () => {
    const { work, repo } = await setup()
    await write(path.join(work, 'collections', 'x.yml'), 'a: 1\r\nb: 2\r\n')
    await commitAll(work, 'crlf')
    expect(await repo.storedLineEndings(['collections'])).toEqual([
      { path: 'collections/x.yml', index: 'crlf', worktree: 'crlf' }
    ])
    expect(
      (await repo.attributes(['collections/x.yml'], ['eol'])).get('collections/x.yml')
    ).toEqual({ eol: 'unspecified' })

    await write(path.join(work, '.gitattributes'), '/collections/** text=auto eol=lf\n')
    expect(
      (await repo.attributes(['collections/x.yml'], ['eol'])).get('collections/x.yml')
    ).toEqual({ eol: 'lf' })
    // text=auto leaves a file committed with CRLF alone until it is rewritten LF.
    expect((await repo.status()).files.map((change) => change.path)).toEqual(['.gitattributes'])
    await write(path.join(work, 'collections', 'x.yml'), 'a: 1\nb: 2\n')
    await repo.commit(['collections/x.yml', '.gitattributes'], 'LF')
    expect(await repo.storedLineEndings(['collections'])).toMatchObject([{ index: 'lf' }])
    expect((await repo.status()).files).toEqual([])
  })
})

describe('clone', () => {
  it('clones into a new folder named after the repository', async () => {
    const { remote } = await setup()
    const parent = path.join(tmp, 'clones')
    await fs.mkdir(parent)
    const lines: string[] = []
    const target = await clone(remote, parent, { onProgress: (line) => lines.push(line) })
    expect(target).toBe(path.join(parent, 'remote'))
    expect(await fs.readFile(path.join(target, 'a.yml'), 'utf8')).toBe('a: 1\n')
    expect(lines.some((line) => line.startsWith('Cloning into'))).toBe(true)
  })

  it('throws git’s message when it fails', async () => {
    await expect(clone(path.join(tmp, 'nowhere.git'), tmp)).rejects.toBeInstanceOf(GitCommandError)
  })

  it('refuses a folder name Windows refuses, on every platform', async () => {
    await expect(clone(path.join(tmp, 'aux.git'), tmp)).rejects.toThrow(
      'Cannot clone into "aux": "aux" is reserved on Windows'
    )
  })
})

describe('switching to a branch that is not there', () => {
  it('refuses, and never reads a name as an option', async () => {
    const { repo } = await setup()
    await expect(repo.switchBranch('nope')).rejects.toThrow('There is no branch nope.')
    await expect(repo.switchBranch('--detach')).rejects.toMatchObject({ kind: 'refused' })
    expect((await repo.status()).branch).toBe('main')
  })
})
