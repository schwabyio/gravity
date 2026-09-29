import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyEnvironmentEdits,
  createEnvironmentFile,
  deleteEnvironmentFile,
  editEnvironmentSource,
  environmentFileName,
  environmentsDirFor
} from './environmentEdits.js'

const SOURCE = [
  '# Shared by every collection here.',
  'name: demo',
  'vars:',
  '  baseUrl: https://demo.test # the sandbox',
  '  # a real boolean',
  '  strict: true',
  '  apiKey: { secret: true, description: from the vault }',
  ''
].join('\n')

describe('editEnvironmentSource', () => {
  it('changes one variable in place, keeping every comment', () => {
    const next = editEnvironmentSource(SOURCE, [
      {
        key: 'vars',
        value: {
          baseUrl: 'https://staging.test',
          strict: true,
          apiKey: { secret: true, description: 'from the vault' }
        }
      }
    ])
    expect(next).toBe(SOURCE.replace('https://demo.test', 'https://staging.test'))
  })

  it('adds a variable at the end and removes another', () => {
    const next = editEnvironmentSource(SOURCE, [
      {
        key: 'vars',
        value: {
          baseUrl: 'https://demo.test',
          apiKey: { secret: true, description: 'from the vault' },
          retries: 3
        }
      }
    ])
    expect(next).not.toContain('strict')
    expect(next).toContain(
      '  apiKey: { secret: true, description: from the vault }\n  retries: 3\n'
    )
  })

  it('renames, and adds a name after a leading comment', () => {
    expect(editEnvironmentSource(SOURCE, [{ key: 'name', value: 'sandbox' }])).toBe(
      SOURCE.replace('name: demo', 'name: sandbox')
    )
    const unnamed = '# no name\nvars:\n  a: 1\n'
    expect(editEnvironmentSource(unnamed, [{ key: 'name', value: 'x' }])).toBe(
      '# no name\nname: x\nvars:\n  a: 1\n'
    )
  })

  it('writes a new secret on one line, in a new vars block or an existing one', () => {
    expect(
      editEnvironmentSource('name: x\n', [
        { key: 'vars', value: { a: 1, token: { secret: true } } }
      ])
    ).toBe('name: x\nvars:\n  a: 1\n  token: { secret: true }\n')
    expect(
      editEnvironmentSource('name: x\nvars:\n  a: 1\n', [
        { key: 'vars', value: { a: 1, token: { secret: true } } }
      ])
    ).toBe('name: x\nvars:\n  a: 1\n  token: { secret: true }\n')
  })

  it('writes flags after the vars, and changes one value in place', () => {
    const withFlags = editEnvironmentSource(SOURCE, [
      { key: 'flags', value: { command: 'node scripts/flags.mjs', values: { newCheckout: true } } }
    ])
    // A small map goes on one line, as the app writes a secret (SPEC.md §7).
    expect(withFlags).toContain(
      'flags:\n  command: node scripts/flags.mjs\n  values: { newCheckout: true }\n'
    )
    const changed = editEnvironmentSource(withFlags, [
      { key: 'flags', value: { command: 'node scripts/flags.mjs', values: { newCheckout: false } } }
    ])
    expect(changed).toBe(withFlags.replace('newCheckout: true', 'newCheckout: false'))
  })

  it('refuses a value that is not plain data', () => {
    expect(() =>
      editEnvironmentSource(SOURCE, [{ key: 'vars', value: { id: { uuid: true } } }])
    ).toThrow()
  })
})

describe('environment files', () => {
  let root: string
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-env-')))
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  it('names a file after the environment', () => {
    expect(environmentFileName('Staging EU')).toBe('staging-eu.yml')
    expect(environmentFileName('  ')).toBe('environment.yml')
  })

  it('puts environments in the project’s own environments/, never one further up', async () => {
    const collection = path.join(root, 'api', 'collections', 'sub', 'shop.yml')
    await fs.mkdir(path.join(root, 'environments'))
    expect(await environmentsDirFor(collection)).toBe(path.join(root, 'api', 'environments'))
  })

  it('refuses a name whose file Windows would not allow', async () => {
    await expect(createEnvironmentFile(path.join(root, 'environments'), 'con')).rejects.toThrow(
      'reserved on Windows'
    )
  })

  it('creates a file, refusing a name already used, and deletes it', async () => {
    const directory = path.join(root, 'environments')
    const created = await createEnvironmentFile(directory, 'Staging EU')
    expect(created.path).toBe(path.join(directory, 'staging-eu.yml'))
    expect(await fs.readFile(created.path, 'utf8')).toBe('name: Staging EU\n')
    await expect(createEnvironmentFile(directory, 'Staging EU')).rejects.toThrow(
      'There is already an environment called "Staging EU"'
    )
    await expect(createEnvironmentFile(directory, 'staging eu')).rejects.toThrow(
      'environments/staging-eu.yml already exists'
    )
    await deleteEnvironmentFile(created.path)
    await expect(fs.stat(created.path)).rejects.toThrow()
    await expect(deleteEnvironmentFile(path.join(root, 'package.json'))).rejects.toThrow(
      'Not an environment file'
    )
  })

  it('writes an edit only against the text it was made against', async () => {
    const directory = path.join(root, 'environments')
    const { path: file, source } = await createEnvironmentFile(directory, 'demo')
    const first = await applyEnvironmentEdits(file, source, [{ key: 'vars', value: { a: 1 } }])
    expect(first).toEqual({ ok: true, source: 'name: demo\nvars:\n  a: 1\n', wrote: true })
    const stale = await applyEnvironmentEdits(file, source, [{ key: 'vars', value: { a: 2 } }])
    expect(stale).toEqual({ ok: false, conflict: true, source: 'name: demo\nvars:\n  a: 1\n' })
  })
})
