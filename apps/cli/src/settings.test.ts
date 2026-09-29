import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, envNameOf, loadSettings, SettingsError } from './settings.js'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gta-settings-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const write = (text: string) => fs.writeFile(path.join(root, 'settings.yml'), text)

describe('loadSettings', () => {
  it('fills in defaults for an empty file', async () => {
    await write('')
    expect(await loadSettings({ root, env: {} })).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS).toMatchObject({
      environmentType: null,
      limitConcurrency: 1,
      bail: false,
      tags: []
    })
  })

  it('layers the file, then GTA_* variables, then flags', async () => {
    await write('environmentType: demo\nlimitConcurrency: 2\ntags: [smoke]\nbail: true\n')
    const settings = await loadSettings({
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
    await expect(loadSettings({ root, env: {} })).rejects.toThrow('must be a map')
  })
})
