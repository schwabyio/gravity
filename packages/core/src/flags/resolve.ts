import { spawn, type ChildProcess } from 'node:child_process'
import { environmentFlags } from '../vars/resolve.js'
import type { EnvironmentDoc } from '../model/documents.js'
import {
  flagValuesOf,
  parseFlagValue,
  type FlagSource,
  type FlagValues,
  type ResolvedFlags
} from './flags.js'

/** How long a flag command may take before the run is stopped. */
export const FLAG_COMMAND_TIMEOUT_MS = 60_000

/** The most a flag command may print. */
const MAX_OUTPUT = 1024 * 1024

export class FlagCommandError extends Error {
  override name = 'FlagCommandError'
}

export interface ResolveFlagsOptions {
  /** The project folder. */
  root: string
  environmentName: string | null
  /** Environment files as edited, used instead of the files at those paths. */
  environments?: Array<{ path: string; doc: EnvironmentDoc }>
  /** Run the environment's `flags.command`. Off, only its fixed values are used. */
  runCommand?: boolean
  /** Values that win over everything else: `--flag name=value`, `GTA_FLAG_name`, app toggles. */
  overrides?: FlagValues
  /** The command's environment; defaults to this process's. */
  env?: Record<string, string | undefined>
  timeoutMs?: number
}

export interface FlagResolution extends ResolvedFlags {
  /** The command that was run, and the folder it ran in; null when none was. */
  command: { command: string; cwd: string } | null
}

/**
 * A run's feature flag values (SPEC.md §2.9), lowest precedence first: the
 * environment file's fixed `flags.values` (its global project's under its own),
 * then what its `flags.command` prints, then overrides.
 *
 * A command that fails, times out or prints anything but a JSON object of flag
 * values throws `FlagCommandError`: running with flags nobody fetched is worse
 * than not running.
 */
export async function resolveFlags(options: ResolveFlagsOptions): Promise<FlagResolution> {
  const values: FlagValues = {}
  const sources: Record<string, FlagSource> = {}
  const take = (from: FlagValues, source: FlagSource) => {
    for (const [name, value] of Object.entries(from)) {
      values[name] = value
      sources[name] = source
    }
  }

  let command: FlagResolution['command'] = null
  if (options.environmentName) {
    const setup = await environmentFlags(
      options.root,
      options.environmentName,
      options.environments
    )
    take(setup.values, 'environment')
    if (setup.command && options.runCommand !== false) {
      command = setup.command
      take(
        await runFlagCommand(setup.command.command, {
          cwd: setup.command.cwd,
          env: options.env ?? process.env,
          timeoutMs: options.timeoutMs ?? FLAG_COMMAND_TIMEOUT_MS
        }),
        'command'
      )
    }
  }
  take(options.overrides ?? {}, 'override')
  return { values, sources, command }
}

/**
 * Split a flag command into its program and arguments, the same way on every
 * platform (SPEC.md §2.9). Spaces and tabs separate words. `'…'` keeps what is
 * inside as it is; `"…"` does too, except that `\"` stands for `"` and `\\` for
 * `\`. Anywhere else `\` is an ordinary character, so a Windows path needs no
 * quoting unless it holds a space. There is no shell: no pipes, `&&`,
 * redirection, `$VAR` or `%VAR%`.
 */
export function splitCommand(command: string): string[] {
  const words: string[] = []
  let word: string | null = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (char === ' ' || char === '\t') {
      if (word !== null) words.push(word)
      word = null
    } else if (char === "'" || char === '"') {
      const close = char
      word ??= ''
      for (index++; ; index++) {
        if (index >= command.length) {
          throw new FlagCommandError(
            `feature flag command \`${command}\` has a ${close} with no closing ${close}`
          )
        }
        const inner = command[index]!
        if (inner === close) break
        const next = command[index + 1]
        if (close === '"' && inner === '\\' && (next === '"' || next === '\\')) {
          word += next
          index++
        } else word += inner
      }
    } else word = (word ?? '') + char
  }
  if (word !== null) words.push(word)
  if (words.length === 0) throw new FlagCommandError('feature flag command is empty')
  return words
}

/**
 * Run a flag command, in `cwd`, whose standard output is a JSON object of flag
 * names to values. Its standard error is kept for the message when it fails.
 *
 * The program is started directly, never through a shell, so a command means
 * the same on macOS, Linux and Windows.
 */
export function runFlagCommand(
  command: string,
  options: { cwd: string; env: Record<string, string | undefined>; timeoutMs: number }
): Promise<FlagValues> {
  return new Promise((resolve, reject) => {
    let words: string[]
    try {
      words = splitCommand(command)
    } catch (cause) {
      return reject(cause)
    }
    const [program, ...args] = words as [string, ...string[]]
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      // Its own process group, so a timeout stops whatever it started too.
      detached: process.platform !== 'win32'
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stopTree(child)
      const detail = stderr.trim().split('\n').slice(-5).join('\n')
      reject(
        new FlagCommandError(
          `feature flag command \`${command}\` ${message}${detail ? `:\n${detail}` : ''}`
        )
      )
    }
    const timer = setTimeout(
      () => fail(`did not finish within ${options.timeoutMs / 1000}s`),
      options.timeoutMs
    )
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_OUTPUT) fail(`printed more than ${MAX_OUTPUT / 1024} KB`)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192)
    })
    child.on('error', (error: NodeJS.ErrnoException) => fail(startFailure(program, error)))
    child.on('close', (code, signal) => {
      if (settled) return
      if (code !== 0) return fail(signal ? `was stopped (${signal})` : `exited with code ${code}`)
      let parsed: unknown
      try {
        parsed = JSON.parse(stdout)
      } catch {
        return fail('did not print JSON')
      }
      const flags = flagValuesOf(parsed)
      if (typeof flags === 'string') return fail(flags)
      settled = true
      clearTimeout(timer)
      resolve(flags)
    })
  })
}

/** Why a program would not start, saying what to write instead where that helps. */
function startFailure(program: string, error: NodeJS.ErrnoException): string {
  // Without a shell, Windows starts only real programs: `npx` is `npx.cmd`.
  const script =
    'a .cmd or .bat script, such as npx, cannot be started without a shell, so name the ' +
    'program it runs, such as node, instead (SPEC.md §2.9)'
  if (error.code === 'EINVAL') return `could not start ${program}: ${script}`
  if (error.code === 'ENOENT') {
    return (
      `could not start: ${program} was not found. The first word is a program on the PATH, ` +
      `or a path from the project folder` +
      (process.platform === 'win32' ? `; ${script}` : ' (SPEC.md §2.9)')
    )
  }
  return `could not start: ${error.message}`
}

/** Stop a command and anything it started. */
function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  if (process.platform === 'win32') {
    // No process groups on Windows: taskkill follows the tree.
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    }).on('error', () => child.kill())
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/**
 * Overrides from `--flag name=value` (any number) and `GTA_FLAG_<name>`
 * environment variables, the command line winning.
 */
export function flagOverrides(
  cli: readonly string[],
  env: Record<string, string | undefined>
): FlagValues {
  const overrides: FlagValues = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('GTA_FLAG_') && value !== undefined && key.length > 'GTA_FLAG_'.length) {
      overrides[key.slice('GTA_FLAG_'.length)] = parseFlagValue(value)
    }
  }
  for (const pair of cli) {
    const equals = pair.indexOf('=')
    if (equals <= 0)
      throw new Error(`--flag ${pair}: write it as name=value, such as newCheckout=true`)
    overrides[pair.slice(0, equals).trim()] = parseFlagValue(pair.slice(equals + 1))
  }
  return overrides
}
