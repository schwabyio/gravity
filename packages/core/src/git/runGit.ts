import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface GitResult {
  stdout: string
  stderr: string
  /** 0 on success. Non-zero is returned rather than thrown. */
  code: number
}

export interface RunGitOptions {
  cwd: string
  signal?: AbortSignal
  /** Milliseconds before the child is killed. */
  timeout?: number
  /** Written to git's stdin: a commit message, a pathspec list. Otherwise stdin is closed at once. */
  input?: string
  /** Set for this call only, over everything else. */
  env?: Record<string, string | undefined>
  /**
   * A command that talks to a remote. Adds the runtime's network settings —
   * credential helpers, and whether a sign-in window may open.
   */
  network?: { interactive: boolean }
  /** Bytes of stdout before the child is killed. */
  maxBuffer?: number
  /** Each line of stderr as it arrives, for clone and fetch progress. */
  onProgress?: (line: string) => void
}

/**
 * Which git to run, and with what environment.
 *
 * Core runs whatever `git` is on PATH, which is right for the `gta` CLI in a
 * terminal or on CI. The desktop app swaps in the git it bundles, so it works on
 * a machine without one — it calls `configureGit` once at startup.
 */
export interface GitRuntime {
  /** The executable. `git` finds it on PATH. */
  binary: string
  /** The environment git runs with, before the fixed settings below. */
  env: NodeJS.ProcessEnv
  /** Extra environment for commands that talk to a remote. */
  networkEnv?: (options: { interactive: boolean }) => Record<string, string>
  /** True when `binary` is the git bundled with the desktop app. */
  bundled: boolean
}

const defaultRuntime = (): GitRuntime => ({ binary: 'git', env: process.env, bundled: false })

let runtime: GitRuntime = defaultRuntime()

/** Point every later git call at another binary or environment. */
export function configureGit(next: Partial<GitRuntime>): void {
  runtime = { ...runtime, ...next }
  cachedVersion = undefined
}

/** Back to the system git on PATH: a test seam. */
export function resetGitRuntime(): void {
  runtime = defaultRuntime()
  cachedVersion = undefined
}

export const gitRuntime = (): Readonly<GitRuntime> => runtime

/**
 * Variables that point git at another repository or config. They are set when
 * the app is started from a git hook or a script, and would silently turn every
 * command toward that repository instead of the one asked for.
 */
const INHERITED_ONLY = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT'
])

const isInheritedOnly = (key: string) =>
  INHERITED_ONLY.has(key.toUpperCase()) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/i.test(key)

function gitEnv(options: RunGitOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(runtime.env)) {
    if (!isInheritedOnly(key)) env[key] = value
  }
  return {
    ...env,
    // Never block on an interactive credential or SSH prompt: a GUI has
    // nowhere to type the answer, so fail fast and report it instead.
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...(options.network && runtime.networkEnv ? runtime.networkEnv(options.network) : {}),
    ...options.env
  }
}

/**
 * The single choke point for every git invocation.
 *
 * Running real git rather than reimplementing it means private repos, SSH
 * agents, credential helpers, hooks, LFS and submodules all work with no code
 * of our own.
 *
 * A non-zero exit is data, not an exception: callers decide whether "not a repo"
 * or "no upstream" is a failure.
 */
export function runGit(args: string[], options: RunGitOptions): Promise<GitResult> {
  const timeout = options.timeout ?? 30_000
  const limit = options.maxBuffer ?? 32 * 1024 * 1024

  return new Promise((resolve, reject) => {
    const child = spawn(runtime.binary, args, {
      cwd: options.cwd,
      env: gitEnv(options),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let size = 0
    let stopped: string | null = null
    let partial = ''

    const stop = (reason: string) => {
      if (stopped) return
      stopped = reason
      child.kill()
    }
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeout / 1000)}s`), timeout)
    const onAbort = () => stop('was cancelled')
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) stop('produced too much output')
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.push(chunk)
      if (!options.onProgress) return
      // Progress redraws one line with \r; each redraw is a line here.
      partial += chunk.toString('utf8')
      const lines = partial.split(/[\r\n]/)
      partial = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') options.onProgress(line)
    })
    // git may exit before it reads stdin; the resulting EPIPE is not our failure.
    child.stdin.on('error', () => undefined)
    child.stdin.end(options.input ?? '')

    child.on('error', (error: NodeJS.ErrnoException) => {
      done()
      if (error.code === 'ENOENT') {
        // spawn says ENOENT for a missing working directory as well as a
        // missing binary; only the second means git is unavailable.
        if (!existsSync(options.cwd)) {
          resolve({
            stdout: '',
            stderr: `cannot change to '${options.cwd}': No such file or directory`,
            code: 128
          })
        } else {
          reject(new GitUnavailableError(runtime))
        }
        return
      }
      resolve({ stdout: '', stderr: error.message, code: 1 })
    })
    child.on('close', (code) => {
      done()
      let err = Buffer.concat(stderr).toString('utf8')
      if (stopped)
        err = `${err}${err && !err.endsWith('\n') ? '\n' : ''}git ${args[0] ?? ''} ${stopped}`
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: err,
        code: stopped ? code || 1 : (code ?? 1)
      })
    })
  })
}

/** Thrown only when the git binary itself cannot be found. */
export class GitUnavailableError extends Error {
  constructor(from: Pick<GitRuntime, 'binary' | 'bundled'> = { binary: 'git', bundled: false }) {
    super(
      from.bundled
        ? `the bundled git is missing (${from.binary})`
        : 'git is not installed or is not on PATH'
    )
    this.name = 'GitUnavailableError'
  }
}

let cachedVersion: string | null | undefined

/** The configured git's version, or null if it is unavailable. Probed once per runtime. */
export async function gitVersion(cwd = process.cwd()): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const result = await runGit(['--version'], { cwd, timeout: 5_000 })
    cachedVersion = result.code === 0 ? result.stdout.trim().replace(/^git version /, '') : null
  } catch {
    cachedVersion = null
  }
  return cachedVersion
}

/** Test seam: forget the probed version. */
export function resetGitVersionCache(): void {
  cachedVersion = undefined
}

/**
 * True when `version` (as `gitVersion` reports it) is at least `major.minor`.
 *
 * Apple and Git for Windows append their own suffixes, which are ignored.
 */
export function gitAtLeast(version: string | null, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(version ?? '')
  if (!match) return false
  const [have, haveMinor] = [Number(match[1]), Number(match[2])]
  return have > major || (have === major && haveMinor >= minor)
}
