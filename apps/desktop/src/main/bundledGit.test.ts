import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gitRuntime, resetGitRuntime, runGit } from '@schwabyio/gravity-core'
import { afterAll, describe, expect, it } from 'vitest'
import {
  credentialConfig,
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
    expect(await helpers({ interactive: true })).toMatch(/^command\tmanager$/m)
  })
})
