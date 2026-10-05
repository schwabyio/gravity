import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  DEFAULT_SOURCE,
  envNameOf,
  loadSettings,
  SettingsError
} from './settings.js'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-settings-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const write = (text: string) => fs.writeFile(path.join(root, 'settings.yml'), text)

/** A global project beside the project, with `text` as its settings.yml; null for none. */
async function sharedProject(text: string | null) {
  const shared = path.join(root, 'shared')
  await fs.mkdir(shared)
  if (text !== null) await fs.writeFile(path.join(shared, 'settings.yml'), text)
  return { root: shared, uses: '../shared' }
}

describe('loadSettings', () => {
  it('fills in defaults for an empty file', async () => {
    await write('')
    const { settings, sources } = await loadSettings({ root, env: {} })
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect(Object.values(sources).every((source) => source === DEFAULT_SOURCE)).toBe(true)
    expect(DEFAULT_SETTINGS).toMatchObject({
      environmentType: null,
      limitConcurrency: 1,
      bail: false,
      tags: []
    })
  })

  it('layers the file, then GTA_* variables, then flags', async () => {
    await write('environmentType: demo\nlimitConcurrency: 2\ntags: [smoke]\nbail: true\n')
    const { settings, sources } = await loadSettings({
      root,
      env: { GTA_LIMIT_CONCURRENCY: '6', GTA_ENVIRONMENT_TYPE: 'staging' },
      overrides: { environmentType: 'prod', tags: 'api, slow', bail: 'false' }
    })
    expect(settings).toMatchObject({
      environmentType: 'prod',
      limitConcurrency: 6,
      tags: ['api', 'slow'],
      bail: false
    })
    expect(sources).toMatchObject({
      environmentType: '--environmentType',
      limitConcurrency: 'GTA_LIMIT_CONCURRENCY',
      bail: '--bail',
      timeoutCollection: DEFAULT_SOURCE
    })
  })

  it('names the variable for each setting', () => {
    expect(envNameOf('limitConcurrency')).toBe('GTA_LIMIT_CONCURRENCY')
    expect(envNameOf('bail')).toBe('GTA_BAIL')
  })

  it('refuses an unknown setting, listing the real ones', async () => {
    await write('limitConcurency: 4\n')
    await expect(loadSettings({ root, env: {} })).rejects.toThrow(
      /Unknown setting "limitConcurency" \(from settings.yml\)\. Settings are: environmentType, limitConcurrency/
    )
    await write('')
    await expect(loadSettings({ root, env: {}, overrides: { nope: '1' } })).rejects.toThrow(
      'Unknown setting "nope" (from --nope)'
    )
    await expect(loadSettings({ root, env: {}, overrides: { toString: '1' } })).rejects.toThrow(
      'Unknown setting "toString"'
    )
  })

  it('says which layer a bad value came from', async () => {
    await write('limitConcurrency: 0\n')
    await expect(loadSettings({ root, env: {} })).rejects.toThrow(
      'limitConcurrency (from settings.yml)'
    )
    await write('')
    await expect(loadSettings({ root, env: { GTA_LIMIT_CONCURRENCY: 'many' } })).rejects.toThrow(
      'limitConcurrency (from GTA_LIMIT_CONCURRENCY)'
    )
    await expect(loadSettings({ root, env: {}, overrides: { bail: 'yes' } })).rejects.toThrow(
      'bail (from --bail)'
    )
    await expect(loadSettings({ root, env: {}, overrides: { tags: 'has space' } })).rejects.toThrow(
      'tags (from --tags)'
    )
  })

  it('wants a value for a setting that is not a switch', async () => {
    await write('')
    await expect(
      loadSettings({ root, env: {}, overrides: { environmentType: true } })
    ).rejects.toThrow('--environmentType needs a value')
  })

  it('explains a missing or broken file', async () => {
    await expect(loadSettings({ root, env: {} })).rejects.toThrow(SettingsError)
    await expect(loadSettings({ root, env: {} })).rejects.toThrow('There is no settings.yml')
    await write('limitConcurrency: [\n')
    await expect(loadSettings({ root, env: {} })).rejects.toThrow('settings.yml will not parse')
    await write('- a list\n')
    await expect(loadSettings({ root, env: {} })).rejects.toThrow(
      'settings.yml must be a map, such as limitConcurrency: 4'
    )
  })

  describe('with a global project', () => {
    it('lies under the project’s own file, key by key', async () => {
      const global = await sharedProject(
        'environmentType: stage\nlimitConcurrency: 4\ntags: [smoke]\ngenerateJUnitResults: true\n'
      )
      await write('limitConcurrency: 8\ntags: []\n')
      const { settings, sources } = await loadSettings({ root, global, env: {} })
      expect(settings).toMatchObject({
        environmentType: 'stage',
        limitConcurrency: 8,
        tags: [],
        generateJUnitResults: true,
        bail: false
      })
      expect(sources).toMatchObject({
        environmentType: '../shared/settings.yml',
        limitConcurrency: 'settings.yml',
        tags: 'settings.yml',
        generateJUnitResults: '../shared/settings.yml',
        bail: DEFAULT_SOURCE
      })
    })

    it('lets the project set a shared key back to its default', async () => {
      const global = await sharedProject('environmentType: stage\nbail: true\n')
      await write('environmentType: null\nbail: false\n')
      const { settings } = await loadSettings({ root, global, env: {} })
      expect(settings).toEqual(DEFAULT_SETTINGS)
    })

    it('lies under GTA_* variables and flags too', async () => {
      const global = await sharedProject('limitConcurrency: 4\nbail: true\n')
      await write('')
      const { settings, sources } = await loadSettings({
        root,
        global,
        env: { GTA_LIMIT_CONCURRENCY: '6' },
        overrides: { bail: 'false' }
      })
      expect(settings).toMatchObject({ limitConcurrency: 6, bail: false })
      expect(sources).toMatchObject({ limitConcurrency: 'GTA_LIMIT_CONCURRENCY', bail: '--bail' })
    })

    it('shares nothing when the global project has no settings.yml', async () => {
      const global = await sharedProject(null)
      await write('limitConcurrency: 3\n')
      const { settings, sources } = await loadSettings({ root, global, env: {} })
      expect(settings).toEqual({ ...DEFAULT_SETTINGS, limitConcurrency: 3 })
      expect(sources.limitConcurrency).toBe('settings.yml')
    })

    it('still needs the project’s own settings.yml', async () => {
      const global = await sharedProject('limitConcurrency: 4\n')
      await expect(loadSettings({ root, global, env: {} })).rejects.toThrow(
        'There is no settings.yml'
      )
    })

    it('names the global project’s file when it is the one to fix', async () => {
      const global = await sharedProject('limitConcurency: 4\n')
      await write('')
      await expect(loadSettings({ root, global, env: {} })).rejects.toThrow(
        'Unknown setting "limitConcurency" (from ../shared/settings.yml)'
      )
      await fs.writeFile(path.join(global.root, 'settings.yml'), 'limitConcurrency: 0\n')
      await expect(loadSettings({ root, global, env: {} })).rejects.toThrow(
        'limitConcurrency (from ../shared/settings.yml)'
      )
      await fs.writeFile(path.join(global.root, 'settings.yml'), 'limitConcurrency: [\n')
      await expect(loadSettings({ root, global, env: {} })).rejects.toThrow(
        '../shared/settings.yml will not parse'
      )
      await fs.writeFile(path.join(global.root, 'settings.yml'), '- a list\n')
      await expect(loadSettings({ root, global, env: {} })).rejects.toThrow(
        '../shared/settings.yml must be a map'
      )
    })
  })
})
