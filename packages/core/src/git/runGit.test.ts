import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureGit, gitAtLeast, GitUnavailableError, resetGitRuntime, runGit } from './runGit.js'

afterEach(() => resetGitRuntime())

const cwd = os.tmpdir()

describe('runGit', () => {
  it('writes input to stdin', async () => {
    const result = await runGit(['hash-object', '--stdin'], { cwd, input: 'hello\n' })
    expect(result.code).toBe(0)
    // `echo hello | git hash-object --stdin`
    expect(result.stdout.trim()).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
  })

  it('ignores an inherited GIT_DIR, which would point git at another repository', async () => {
    configureGit({ env: { ...process.env, GIT_DIR: '/nowhere/.git' } })
    const result = await runGit(['rev-parse', '--git-dir'], { cwd })
    // Outside a repository: not "/nowhere/.git".
    expect(result.stdout).not.toContain('/nowhere')
  })

  it('adds the network environment only to network commands', async () => {
    configureGit({
      networkEnv: () => ({
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'gravity.test',
        GIT_CONFIG_VALUE_0: 'yes'
      })
    })
    const read = (network?: { interactive: boolean }) =>
      runGit(['config', '--get', 'gravity.test'], { cwd, ...(network ? { network } : {}) })
    expect((await read()).stdout.trim()).toBe('')
    expect((await read({ interactive: true })).stdout.trim()).toBe('yes')
  })

  it('returns a missing working directory as a failure rather than "git is missing"', async () => {
    const result = await runGit(['status'], { cwd: path.join(cwd, 'no-such-dir-gravity') })
    expect(result.code).not.toBe(0)
  })

  it('throws GitUnavailableError when the binary does not exist', async () => {
    configureGit({ binary: path.join(cwd, 'no-such-git') })
    await expect(runGit(['--version'], { cwd })).rejects.toBeInstanceOf(GitUnavailableError)
  })

  it('stops a command that runs too long, and says so', async () => {
    const result = await runGit(['-c', 'alias.nap=!sleep 1', 'nap'], { cwd, timeout: 100 })
    expect(result.code).not.toBe(0)
    expect(result.stderr).toMatch(/timed out/)
  })
})

describe('gitAtLeast', () => {
  it('compares major and minor, ignoring vendor suffixes', () => {
    expect(gitAtLeast('2.50.1 (Apple Git-155)', 2, 31)).toBe(true)
    expect(gitAtLeast('2.53.0.windows.4', 2, 53)).toBe(true)
    expect(gitAtLeast('2.25.1', 2, 26)).toBe(false)
    expect(gitAtLeast(null, 2, 0)).toBe(false)
  })
})
