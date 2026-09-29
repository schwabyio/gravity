import type { GitResult } from './runGit.js'

/**
 * Why a git command failed, in the few categories a person can act on.
 *
 * git's own message is always kept and shown; the kind picks a one-line hint
 * that says what to do next, because "fatal: could not read Username" does not.
 */
export type GitErrorKind =
  | 'auth'
  | 'ssh-key'
  | 'ssh-host'
  | 'network'
  | 'identity'
  | 'rejected'
  | 'remote-rejected'
  | 'dirty'
  | 'untracked-overwritten'
  | 'lock'
  | 'signing'
  | 'hook'
  | 'dubious-ownership'
  /** Our own refusal: the repository is in a state the operation does not handle. */
  | 'refused'
  /** A pull whose rebase conflicted and was undone. */
  | 'conflict'
  | 'other'

const PATTERNS: ReadonlyArray<{ kind: GitErrorKind; test: RegExp; hint: string }> = [
  {
    kind: 'dubious-ownership',
    test: /detected dubious ownership/i,
    hint: 'git refuses a repository owned by another user. If you trust it, run: git config --global --add safe.directory <its path>'
  },
  {
    kind: 'lock',
    test: /\.lock': File exists|Unable to create '[^']*\.lock'/i,
    hint: 'Another git command is running in this repository, or one crashed. Try again; if it keeps happening, delete .git/index.lock.'
  },
  {
    kind: 'identity',
    test: /Please tell me who you are|Author identity unknown|empty ident name|unable to auto-detect email address/i,
    hint: 'git needs your name and email for a commit. Add them and commit again.'
  },
  {
    kind: 'signing',
    test: /gpg failed to sign|failed to sign the data|error: gpg|ssh-keygen.*(sign|-Y)/i,
    hint: 'Your git config signs commits, and signing failed. Check that your signing key works from a terminal.'
  },
  {
    kind: 'ssh-key',
    test: /Permission denied \(publickey/i,
    hint: 'The remote refused your SSH key. Add it to your ssh-agent (ssh-add): the app uses your system ssh.'
  },
  {
    kind: 'ssh-host',
    test: /Host key verification failed/i,
    hint: 'SSH does not know this host yet. Connect once from a terminal (for example ssh -T git@github.com) to trust it.'
  },
  {
    kind: 'auth',
    test: /Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]|Repository not found|Invalid username or (password|token)/i,
    hint: 'Sign-in failed. Try again and Git Credential Manager will ask you to sign in, or sign in once with git in a terminal.'
  },
  {
    kind: 'network',
    test: /Could not resolve host|Connection timed out|Operation timed out|Failed to connect|Connection refused|Could not read from remote repository|unable to access/i,
    hint: 'Could not reach the remote. Check your network or VPN.'
  },
  {
    kind: 'remote-rejected',
    test: /\[remote rejected\]|protected branch|pre-receive hook declined/i,
    hint: 'The remote refused the push, often because the branch is protected. Push a new branch and open a pull request instead.'
  },
  {
    kind: 'rejected',
    test: /\[rejected\]|non-fast-forward|\(fetch first\)|Updates were rejected/i,
    hint: 'The remote has commits you do not have. Pull, then push again.'
  },
  {
    kind: 'dirty',
    test: /Your local changes to the following files would be overwritten/i,
    hint: 'Commit or discard those changes first.'
  },
  {
    kind: 'untracked-overwritten',
    test: /untracked working tree files would be (overwritten|removed)/i,
    hint: 'Move or delete those untracked files first.'
  },
  {
    kind: 'hook',
    test: /hook\b.*(failed|declined|exited)|husky|lint-staged/i,
    hint: 'A git hook in this repository stopped the operation. Its output is above.'
  }
]

/** The kind of failure git's output describes, and what to do about it. */
export function explainGitFailure(output: string): { kind: GitErrorKind; hint: string | null } {
  for (const pattern of PATTERNS) {
    if (pattern.test.test(output)) return { kind: pattern.kind, hint: pattern.hint }
  }
  return { kind: 'other', hint: null }
}

/** git's output without its own `hint:` advice, which names commands for a terminal. */
export function gitMessage(result: Pick<GitResult, 'stdout' | 'stderr'>): string {
  const lines = (result.stderr.trim() || result.stdout.trim())
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !line.startsWith('hint:'))
  return lines.slice(0, 20).join('\n')
}

export class GitCommandError extends Error {
  readonly kind: GitErrorKind
  /** What to do next, or null when git's message says it all. */
  readonly hint: string | null
  /** git's full error output. */
  readonly stderr: string
  /** For a pull whose rebase conflicted: the files that conflicted. */
  readonly conflicts: string[]

  constructor(
    message: string,
    options: {
      kind?: GitErrorKind
      hint?: string | null
      stderr?: string
      conflicts?: string[]
    } = {}
  ) {
    super(message)
    this.name = 'GitCommandError'
    const explained = explainGitFailure(options.stderr ?? message)
    this.kind = options.kind ?? explained.kind
    this.hint = options.hint !== undefined ? options.hint : explained.hint
    this.stderr = options.stderr ?? ''
    this.conflicts = options.conflicts ?? []
  }

  /** From a failed command: git's message, and the hint its output matches. */
  static from(result: GitResult, fallback: string): GitCommandError {
    const output = `${result.stderr}\n${result.stdout}`
    return new GitCommandError(gitMessage(result) || fallback, { stderr: output })
  }

  /** Our own refusal, before git ran. */
  static refused(message: string, hint: string | null = null): GitCommandError {
    return new GitCommandError(message, { kind: 'refused', hint })
  }
}
