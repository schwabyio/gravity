import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitRuntime, resetGitRuntime, runGit } from '@schwabyio/gravity-core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  credentialConfig,
  fallbackNote,
  loginShellPath,
  mergePaths,
  networkEnvFor,
  parseLoginShellOutput,
  setupGit,
  systemCaBundle,
  toConfigEnv,
  type CredentialInputs
} from './bundledGit.js'

const inputs = (over: Partial<CredentialInputs> = {}): CredentialInputs => ({
  platform: 'darwin',
  env: {},
  userHelpers: [],
  userCredentialStore: null,
  keychainHelper:
    '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain',
  manager: true,
  ...over
})

describe('credentialConfig', () => {
  it('adds the system Keychain helper, then Git Credential Manager, on macOS', () => {
    expect(credentialConfig(inputs())).toEqual([
      [
        'credential.helper',
        '/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain'
      ],
      ['credential.helper', 'manager']
    ])
  })

  it('skips a helper the person already has', () => {
    expect(credentialConfig(inputs({ userHelpers: ['manager'], keychainHelper: null }))).toEqual([])
  })

  it('uses only Git Credential Manager on Windows', () => {
    expect(credentialConfig(inputs({ platform: 'win32', keychainHelper: null }))).toEqual([
      ['credential.helper', 'manager']
    ])
  })

  it('picks a store on Linux, where GCM has none by default', () => {
    const linux = { platform: 'linux' as const, keychainHelper: null }
    expect(credentialConfig(inputs({ ...linux, env: { DBUS_SESSION_BUS_ADDRESS: 'x' } }))).toEqual([
      ['credential.helper', 'manager'],
      ['credential.credentialStore', 'secretservice']
    ])
    expect(credentialConfig(inputs(linux))).toContainEqual(['credential.credentialStore', 'cache'])
    expect(credentialConfig(inputs({ ...linux, userCredentialStore: 'gpg' }))).toEqual([
      ['credential.helper', 'manager']
    ])
  })

  it('adds nothing when the bundled git has no credential manager', () => {
    expect(credentialConfig(inputs({ manager: false, keychainHelper: null }))).toEqual([])
  })
})

describe('config through the environment', () => {
  it('numbers each setting', () => {
    expect(toConfigEnv([['credential.helper', 'manager']])).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'manager'
    })
  })

  it('never lets a background command prompt', () => {
    const env = networkEnvFor([['credential.helper', 'manager']])
    expect(env({ interactive: true })).not.toHaveProperty('GCM_INTERACTIVE')
    expect(env({ interactive: false })).toMatchObject({
      GCM_INTERACTIVE: 'never',
      SSH_ASKPASS_REQUIRE: 'never'
    })
  })
})

describe('the login shell PATH', () => {
  it('is read between the sentinels, whatever rc files print', () => {
    expect(
      parseLoginShellOutput('Welcome!\n__GRAVITY_PATH__/opt/homebrew/bin:/usr/bin__GRAVITY_PATH__')
    ).toBe('/opt/homebrew/bin:/usr/bin')
    expect(parseLoginShellOutput('no sentinels')).toBeNull()
  })

  it.skipIf(process.platform === 'win32')(
    'is answered as soon as it is printed, whatever the shell leaves running',
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gravity-shell-'))
      const shell = path.join(dir, 'slow-shell')
      // Prints a greeting, then the PATH, then takes its time to exit.
      await fs.writeFile(shell, '#!/bin/sh\necho "Welcome"\neval "$2"\nsleep 20\n', {
        mode: 0o755
      })
      const started = Date.now()
      const found = await loginShellPath({ SHELL: shell, PATH: '/usr/bin:/bin' }, 'darwin')
      expect(Date.now() - started).toBeLessThan(3_000)
      expect(found).toBe('/usr/bin:/bin')
      await fs.rm(dir, { recursive: true, force: true })
    }
  )

  it('merges without repeating an entry', () => {
    expect(mergePaths('/a:/b', '/b:/c')).toBe('/a:/b:/c')
    expect(mergePaths('C:\\a;C:\\b', 'C:\\b', ';')).toBe('C:\\a;C:\\b')
  })
})

describe('the CA bundle git trusts on Linux', () => {
  it('is the system’s, found where the distribution keeps it', () => {
    const fedora = '/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem'
    expect(systemCaBundle('linux', (file) => file === fedora)).toBe(fedora)
    expect(systemCaBundle('linux', () => true)).toBe('/etc/ssl/certs/ca-certificates.crt')
  })

  it('is left to git elsewhere, or where the system has none', () => {
    expect(systemCaBundle('darwin', () => true)).toBeNull()
    expect(systemCaBundle('win32', () => true)).toBeNull()
    expect(systemCaBundle('linux', () => false)).toBeNull()
  })
})

describe('setupGit', () => {
  afterAll(() => resetGitRuntime())

  it('runs the bundled git, and adds credential helpers only to network commands', async () => {
    const setup = await setupGit()
    expect(setup.bundled).toBe(true)
    expect(setup.note).toBeNull()
    expect(setup.version).toMatch(/^\d+\.\d+/)
    expect(gitRuntime().binary).toContain('dugite')

    const cwd = os.homedir()
    const helpers = (network?: { interactive: boolean }) =>
      runGit(['config', '--show-scope', '--get-all', 'credential.helper'], {
        cwd,
        ...(network ? { network } : {})
      }).then((result) => result.stdout)
    expect(await helpers()).not.toMatch(/^command\t/m)
    // The bundled Git for Windows names GCM in its own system config, so nothing is
    // added there; elsewhere it comes from us.
    const scope = process.platform === 'win32' ? 'system' : 'command'
    expect(await helpers({ interactive: true })).toMatch(new RegExp(`^${scope}\tmanager$`, 'm'))
  })
})

describe('when the bundled git is not the one running', () => {
  afterAll(() => resetGitRuntime())

  /** Where dugite looks for git in `folder`, on this platform. */
  const gitIn = (folder: string) =>
    process.platform === 'win32'
      ? path.join(folder, 'cmd', 'git.exe')
      : path.join(folder, 'bin', 'git')

  it('says where it looked when the bundled git is not there, and which git runs instead', async () => {
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-no-git-'))
    try {
      const setup = await setupGit({ ...process.env, LOCAL_GIT_DIRECTORY: empty })
      expect(setup.bundled).toBe(false)
      expect(setup.binary).toBe('git')
      // CI and every developer machine have a git on PATH.
      expect(setup.version).toMatch(/^\d+\.\d+/)
      expect(setup.note).toBe(
        `The bundled git is not at ${gitIn(empty)}, so the system git, ${setup.version}, is used.`
      )
    } finally {
      await fs.rm(empty, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'says what git said when the bundled git is there but fails',
    async () => {
      const broken = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-broken-git-'))
      try {
        await fs.mkdir(path.join(broken, 'bin'))
        await fs.writeFile(gitIn(broken), '#!/bin/sh\necho "cannot load libcurl" >&2\nexit 3\n')
        await fs.chmod(gitIn(broken), 0o755)
        const setup = await setupGit({ ...process.env, LOCAL_GIT_DIRECTORY: broken })
        expect(setup.bundled).toBe(false)
        expect(setup.note).toBe(
          `The bundled git at ${gitIn(broken)} failed git --version: cannot load libcurl, so the system git, ${setup.version}, is used.`
        )
      } finally {
        await fs.rm(broken, { recursive: true, force: true })
      }
    }
  )

  it('names each of the three causes, and what is left', () => {
    const at = '/app/node_modules/dugite/git/bin/git'
    const download = '/app/node_modules/dugite/script/download-git.js'
    expect(fallbackNote({ kind: 'missing', path: at, download }, '2.45.1')).toBe(
      `The bundled git is not at ${at}, so the system git, 2.45.1, is used. To download the bundled git, run: node "${download}"`
    )
    expect(
      fallbackNote(
        { kind: 'failed', path: at, said: 'did not answer git --version within 30 s' },
        '2.45.1.windows.1'
      )
    ).toBe(
      `The bundled git at ${at} did not answer git --version within 30 s, so the system git, 2.45.1.windows.1, is used.`
    )
    expect(fallbackNote({ kind: 'unsupported' }, '2.45.1', 'freebsd-x64')).toBe(
      'There is no bundled git for freebsd-x64, so the system git, 2.45.1, is used.'
    )
  })

  it('says when the system git is too old to change the repository, or missing', () => {
    const missing = { kind: 'missing', path: '/x/bin/git', download: null } as const
    expect(fallbackNote(missing, '2.30.2')).toBe(
      'The bundled git is not at /x/bin/git, so the system git, 2.30.2, is used: too old to commit, pull, push or switch branches from the app, which needs 2.31 or later.'
    )
    expect(fallbackNote(missing, null)).toBe(
      'The bundled git is not at /x/bin/git, and there is no git on PATH either, so git features are off.'
    )
  })
})
