import { spawn } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { configureGit, gitVersion, runGit } from '@schwabyio/gravity-core'
import { setupEnvironment } from 'dugite'

/**
 * The git the app runs: the one bundled with it (dugite), so it works on a
 * machine with no git installed, and behaves the same on every platform.
 *
 * Only git sees what is set up here. `process.env` is left alone, so the run
 * worker keeps the environment the app started with; flag commands take the
 * terminal's PATH from `terminalPath`, as git does.
 *
 * Nothing here imports Electron, so it is tested as plain Node.
 */

export interface GitSetup {
  /** The executable in use. */
  binary: string
  version: string | null
  /** True when the bundled git is in use rather than the system one. */
  bundled: boolean
  /** Why the bundled git is not in use, or null. */
  note: string | null
}

export async function setupGit(): Promise<GitSetup> {
  const setup = await configure(process.env)
  // A terminal's PATH, for hooks and commit signing. The login shell can take a
  // while to start, so git runs with the app's own PATH until it answers.
  void terminalPath().then((PATH) => {
    if (PATH === process.env['PATH']) return
    const env = { ...process.env, PATH }
    configureGit({ env: setup.bundled ? (bundledGit(env)?.env ?? env) : env })
  })
  return setup
}

async function configure(base: NodeJS.ProcessEnv): Promise<GitSetup> {
  const embedded = bundledGit(base)
  if (embedded && (await isExecutable(embedded.gitLocation))) {
    configureGit({
      binary: embedded.gitLocation,
      env: embedded.env,
      bundled: true,
      networkEnv: undefined
    })
    const version = await gitVersion(os.homedir())
    if (version) {
      const inputs = await credentialInputs(embedded.env)
      configureGit({ networkEnv: networkEnvFor(credentialConfig(inputs)) })
      return { binary: embedded.gitLocation, version, bundled: true, note: null }
    }
  }

  // The bundled git is missing (an install with --ignore-scripts, say): the
  // system git is better than none.
  configureGit({ binary: 'git', env: base, bundled: false, networkEnv: undefined })
  const version = await gitVersion(os.homedir())
  return {
    binary: 'git',
    version,
    bundled: false,
    note: 'The bundled git is missing, so the system git is used.'
  }
}

function bundledGit(
  env: NodeJS.ProcessEnv
): { env: NodeJS.ProcessEnv; gitLocation: string } | null {
  try {
    const caBundle = env['GIT_SSL_CAINFO'] ? null : systemCaBundle()
    return setupEnvironment(caBundle ? { GIT_SSL_CAINFO: caBundle } : {}, env)
  } catch {
    // dugite throws on a platform it has no git for.
    return null
  }
}

/**
 * Where Linux keeps the certificates it trusts, for the bundled git.
 *
 * On Linux, dugite points git at a CA bundle of its own, so a clone from a
 * host whose CA the company installed would fail in the app yet work in a
 * terminal. The system's bundle holds the same public roots plus those. macOS
 * and Windows git already use the operating system's trust store.
 */
export function systemCaBundle(
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = existsSync
): string | null {
  if (platform !== 'linux') return null
  return LINUX_CA_BUNDLES.find(exists) ?? null
}

/** Debian and Ubuntu, Fedora and RHEL, openSUSE, then Alpine. */
const LINUX_CA_BUNDLES = [
  '/etc/ssl/certs/ca-certificates.crt',
  '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem',
  '/etc/pki/tls/certs/ca-bundle.crt',
  '/etc/ssl/ca-bundle.pem',
  '/etc/ssl/cert.pem'
]

const isExecutable = (file: string) =>
  fs.access(file, constants.X_OK).then(
    () => true,
    () => false
  )

/* ----------------------------------------------------------- credentials -- */

export interface CredentialInputs {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** The `credential.helper` values the person's own config sets. */
  userHelpers: string[]
  /** Their `credential.credentialStore`, or null. */
  userCredentialStore: string | null
  /** The system git's macOS Keychain helper, by absolute path, or null. */
  keychainHelper: string | null
  /** True when the bundled git carries Git Credential Manager. */
  manager: boolean
}

async function credentialInputs(env: NodeJS.ProcessEnv): Promise<CredentialInputs> {
  const home = os.homedir()
  const helpers = await runGit(['config', '--get-all', 'credential.helper'], { cwd: home })
  const store = await runGit(['config', '--get', 'credential.credentialStore'], { cwd: home })
  const execPath = env['GIT_EXEC_PATH'] ?? ''
  const managerFile = path.join(
    execPath,
    process.platform === 'win32' ? 'git-credential-manager.exe' : 'git-credential-manager'
  )
  return {
    platform: process.platform,
    env,
    userHelpers: helpers.stdout.split(/\r?\n/).filter((line) => line.trim() !== ''),
    userCredentialStore: store.code === 0 ? store.stdout.trim() || null : null,
    keychainHelper: process.platform === 'darwin' ? await firstExisting(KEYCHAIN_HELPERS) : null,
    manager: execPath !== '' && (await isExecutable(managerFile))
  }
}

/** Where a system git keeps its Keychain helper; the bundled git has none. */
export const KEYCHAIN_HELPERS = [
  '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain',
  '/Applications/Xcode.app/Contents/Developer/usr/libexec/git-core/git-credential-osxkeychain',
  '/opt/homebrew/opt/git/libexec/git-core/git-credential-osxkeychain',
  '/usr/local/opt/git/libexec/git-core/git-credential-osxkeychain'
]

async function firstExisting(files: string[]): Promise<string | null> {
  for (const file of files) if (await isExecutable(file)) return file
  return null
}

/**
 * The credential settings added to commands that talk to a remote.
 *
 * git asks each helper in turn, the person's own first. The bundled git skips
 * the system config where Apple's and Git for Windows' installers set a helper,
 * so without these a remote that worked in a terminal would fail here:
 *
 * 1. macOS: the system git's Keychain helper, so logins it already saved work.
 * 2. Git Credential Manager: a browser sign-in, saved in the OS keychain.
 *
 * GCM has no default store on Linux; the Secret Service keyring is used when a
 * desktop session has one, otherwise git's in-memory cache.
 */
export function credentialConfig(inputs: CredentialInputs): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  const add = (helper: string) => {
    if (!inputs.userHelpers.includes(helper)) pairs.push(['credential.helper', helper])
  }
  if (inputs.platform === 'darwin' && inputs.keychainHelper) {
    add(/\s/.test(inputs.keychainHelper) ? `"${inputs.keychainHelper}"` : inputs.keychainHelper)
  }
  if (inputs.manager) {
    add('manager')
    if (
      inputs.platform === 'linux' &&
      !inputs.userCredentialStore &&
      !inputs.env['GCM_CREDENTIAL_STORE']
    ) {
      pairs.push([
        'credential.credentialStore',
        inputs.env['DBUS_SESSION_BUS_ADDRESS'] ? 'secretservice' : 'cache'
      ])
    }
  }
  return pairs
}

/**
 * Config as environment variables. git reads them as if given with `-c`: after
 * every config file, so a helper here is tried after the person's own.
 */
export function toConfigEnv(pairs: Array<[string, string]>): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) }
  pairs.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key
    env[`GIT_CONFIG_VALUE_${index}`] = value
  })
  return env
}

/**
 * The network environment. A background fetch must never open a sign-in window
 * or wait on an SSH prompt; one the person started may.
 */
export function networkEnvFor(pairs: Array<[string, string]>) {
  const config = toConfigEnv(pairs)
  return ({ interactive }: { interactive: boolean }): Record<string, string> =>
    interactive ? config : { ...config, GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never' }
}

/* ------------------------------------------------------------------ PATH -- */

const SENTINEL = '__GRAVITY_PATH__'

let terminalPathOnce: Promise<string> | null = null

/** The login shell's PATH, asked once and shared by git and flag commands. */
export const terminalPath = (): Promise<string> => (terminalPathOnce ??= loginShellPath())

/**
 * The PATH a terminal would have.
 *
 * An app opened from the Dock or a desktop launcher gets a bare PATH, so a
 * repository's hooks (husky running node) and commit signing (gpg) would fail
 * here yet work in a terminal. Asking the login shell once fixes that.
 */
export function loginShellPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<string> {
  const current = env['PATH'] ?? ''
  if (platform === 'win32') return Promise.resolve(current)
  const fallback = mergePaths(current, '/opt/homebrew/bin:/usr/local/bin')
  const shell = env['SHELL'] || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')

  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const answer = () => {
      const login = parseLoginShellOutput(output)
      return login ? mergePaths(login, current) : null
    }
    // Answered as soon as the PATH is printed, not when the shell's output
    // closes: something an rc file starts in the background can hold it open.
    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdout?.destroy()
      child.kill()
      resolve(value)
    }
    const child = spawn(shell, ['-ilc', `printf '${SENTINEL}%s${SENTINEL}' "$PATH"`], {
      env: { ...env, DISABLE_AUTO_UPDATE: 'true' },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    const timer = setTimeout(() => finish(fallback), 5_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      const found = answer()
      if (found) finish(found)
    })
    child.on('error', () => finish(fallback))
    child.on('exit', () => finish(answer() ?? fallback))
  })
}

/** The PATH between the sentinels: rc files may print anything around it. */
export function parseLoginShellOutput(stdout: string): string | null {
  const start = stdout.indexOf(SENTINEL)
  if (start === -1) return null
  const end = stdout.indexOf(SENTINEL, start + SENTINEL.length)
  if (end === -1) return null
  const value = stdout.slice(start + SENTINEL.length, end).trim()
  return value === '' ? null : value
}

/** `first`'s entries, then any of `second`'s not already there. */
export function mergePaths(first: string, second: string, delimiter = ':'): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const entry of [...first.split(delimiter), ...second.split(delimiter)]) {
    if (entry === '' || seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged.join(delimiter)
}
