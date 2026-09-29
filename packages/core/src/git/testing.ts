/**
 * Helpers for tests that build real repositories. Not exported from the package.
 *
 * Every repository here runs with a git config of its own, so the machine's —
 * commit signing, hooks, `pull.rebase`, Windows' `core.autocrlf` — never
 * changes what a test sees.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configureGit, runGit } from './runGit.js'

/** A new temp directory, by its real path (macOS hands out /var for /private/var). */
export const tempDir = async (prefix: string) =>
  fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)))

/** git, throwing its output when it fails. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runGit(args, { cwd })
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (${result.code}):\n${result.stderr}${result.stdout}`
    )
  }
  return result.stdout
}

/** Point git at a config file of the test's own, and nothing of the machine's. */
export async function isolateGit(dir: string, extra = ''): Promise<{ globalConfig: string }> {
  const globalConfig = path.join(dir, 'gitconfig')
  await fs.writeFile(
    globalConfig,
    [
      '[user]',
      '\tname = Test',
      '\temail = test@example.test',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[core]',
      '\tautocrlf = false',
      extra
    ].join('\n')
  )
  configureGit({
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' }
  })
  return { globalConfig }
}

export async function write(file: string, body: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, 'add', '-A')
  await git(dir, 'commit', '--quiet', '-m', message)
}

/** A bare repository to push to and pull from. */
export async function bareRemote(dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  await git(dir, 'init', '--quiet', '--bare', '--initial-branch=main')
  return dir
}

export async function cloneOf(remote: string, dir: string): Promise<string> {
  await git(path.dirname(dir), 'clone', '--quiet', remote, dir)
  return dir
}
