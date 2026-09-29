import { describe, expect, it } from 'vitest'
import { explainGitFailure, GitCommandError, gitMessage } from './errors.js'

describe('explainGitFailure', () => {
  it.each([
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'auth'],
    ['remote: Repository not found.\nfatal: repository not found', 'auth'],
    [
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
      'ssh-key'
    ],
    ['Host key verification failed.', 'ssh-host'],
    ["fatal: unable to access 'https://x/': Could not resolve host: x", 'network'],
    ['*** Please tell me who you are.', 'identity'],
    ['! refs/heads/main:refs/heads/main [rejected] (fetch first)', 'rejected'],
    ['! [remote rejected] main -> main (protected branch hook declined)', 'remote-rejected'],
    ['error: Your local changes to the following files would be overwritten by checkout:', 'dirty'],
    ["fatal: Unable to create '/r/.git/index.lock': File exists.", 'lock'],
    ['error: gpg failed to sign the data', 'signing'],
    ["fatal: detected dubious ownership in repository at '/r'", 'dubious-ownership'],
    ['something else entirely', 'other']
  ])('%s → %s', (output, kind) => {
    expect(explainGitFailure(output).kind).toBe(kind)
  })
})

describe('GitCommandError', () => {
  it("keeps git's message without its hint: lines, and adds our hint", () => {
    const error = GitCommandError.from(
      {
        code: 1,
        stdout: '',
        stderr:
          "hint: Updates were rejected because the remote contains work that you do not\nerror: failed to push some refs to 'origin'\n! [rejected] main -> main (fetch first)\n"
      },
      'The push failed'
    )
    expect(error.message).toBe(
      "error: failed to push some refs to 'origin'\n! [rejected] main -> main (fetch first)"
    )
    expect(error.kind).toBe('rejected')
    expect(error.hint).toMatch(/Pull, then push/)
  })

  it('uses the fallback when git said nothing', () => {
    expect(gitMessage({ stdout: '', stderr: '' })).toBe('')
    expect(GitCommandError.from({ code: 1, stdout: '', stderr: '' }, 'It failed').message).toBe(
      'It failed'
    )
  })
})
