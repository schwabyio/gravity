import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  copyCollectionFile,
  moveCollectionToFolder,
  renameCollectionFile,
  renameCollectionsFolder
} from './projectEdits.js'

let tmp: string

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

const exists = (file: string) =>
  fs.access(file).then(
    () => true,
    () => false
  )

/** A project with `collections/<relative>.yml` holding a commented collection, and its data file. */
async function project(name: string, relative: string, data = true): Promise<string> {
  const root = path.join(tmp, name)
  const id = path.basename(relative)
  await write(
    path.join(root, 'collections', `${relative}.yml`),
    `# kept as written\nid: ${id}\nsteps:\n  - name: get\n    GET: /users\n`
  )
  if (data) await write(path.join(root, 'collections', `${relative}.csv`), 'user\nada\n')
  return root
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-project-edits-')))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('renameCollectionFile', () => {
  it('renames the file and its data file, and rewrites only its id', async () => {
    const root = await project('rename', 'auth/login')
    const renamed = await renameCollectionFile(
      root,
      path.join(root, 'collections/auth/login.yml'),
      ' sign-in '
    )
    expect(renamed).toBe(path.join(root, 'collections/auth/sign-in.yml'))
    expect(await fs.readFile(renamed, 'utf8')).toBe(
      '# kept as written\nid: sign-in\nsteps:\n  - name: get\n    GET: /users\n'
    )
    expect(await fs.readFile(path.join(root, 'collections/auth/sign-in.csv'), 'utf8')).toBe(
      'user\nada\n'
    )
    expect(await exists(path.join(root, 'collections/auth/login.yml'))).toBe(false)
    expect(await exists(path.join(root, 'collections/auth/login.csv'))).toBe(false)
  })

  it('refuses an id another collection has, in any directory or case', async () => {
    const root = await project('taken', 'orders')
    await write(path.join(root, 'collections/billing/Refunds.yml'), 'id: Refunds\nsteps: []\n')
    await expect(
      renameCollectionFile(root, path.join(root, 'collections/orders.yml'), 'refunds')
    ).rejects.toThrow('collections/billing/Refunds.yml already has the id refunds')
    expect(await exists(path.join(root, 'collections/orders.yml'))).toBe(true)
  })

  it('changes only the case of an id', async () => {
    const root = await project('case', 'orders', false)
    const renamed = await renameCollectionFile(
      root,
      path.join(root, 'collections/orders.yml'),
      'Orders'
    )
    expect(await fs.readdir(path.join(root, 'collections'))).toEqual(['Orders.yml'])
    expect(await fs.readFile(renamed, 'utf8')).toContain('id: Orders\n')
  })

  it('refuses an id that is not one', async () => {
    const root = await project('bad-id', 'orders', false)
    const file = path.join(root, 'collections/orders.yml')
    await expect(renameCollectionFile(root, file, 'two words')).rejects.toThrow(
      'An id is letters, digits and - _ .'
    )
    await expect(renameCollectionFile(root, file, 'aux')).rejects.toThrow('reserved on Windows')
  })
})

describe('copyCollectionFile', () => {
  it('copies a collection and its data file into a directory of another project', async () => {
    const from = await project('copy-from', 'ping')
    const to = path.join(tmp, 'copy-to')
    await fs.mkdir(path.join(to, 'collections'), { recursive: true })
    const copied = await copyCollectionFile(path.join(from, 'collections/ping.yml'), to, 'health')
    expect(copied).toBe(path.join(to, 'collections/health/ping.yml'))
    expect(await fs.readFile(copied, 'utf8')).toContain('# kept as written\nid: ping\n')
    expect(await exists(path.join(to, 'collections/health/ping.csv'))).toBe(true)
    // The copy leaves the original.
    expect(await exists(path.join(from, 'collections/ping.yml'))).toBe(true)
    expect(await exists(path.join(from, 'collections/ping.csv'))).toBe(true)
  })

  it('moves one, leaving nothing behind', async () => {
    const from = await project('move-from', 'auth/token')
    const to = path.join(tmp, 'move-to')
    const moved = await copyCollectionFile(
      path.join(from, 'collections/auth/token.yml'),
      to,
      null,
      {
        move: true
      }
    )
    expect(moved).toBe(path.join(to, 'collections/token.yml'))
    expect(await exists(path.join(to, 'collections/token.csv'))).toBe(true)
    expect(await fs.readdir(path.join(from, 'collections/auth'))).toEqual([])
  })

  it('refuses an id the project already has, and its own project', async () => {
    const from = await project('clash-from', 'orders')
    const to = await project('clash-to', 'legacy/ORDERS', false)
    const file = path.join(from, 'collections/orders.yml')
    await expect(copyCollectionFile(file, to, null)).rejects.toThrow(
      'collections/legacy/ORDERS.yml already has the id orders'
    )
    await expect(copyCollectionFile(file, from, 'elsewhere', { move: true })).rejects.toThrow(
      'collections/orders.yml already has the id orders'
    )
    expect(await exists(file)).toBe(true)
  })
})

describe('renameCollectionsFolder', () => {
  it('renames a folder of collections/ with everything in it, ids and all left alone', async () => {
    const root = await project('folder', 'auth/login')
    const renamed = await renameCollectionsFolder(root, 'auth', ' sign-in ')
    expect(renamed).toBe(path.join(root, 'collections/sign-in'))
    expect((await fs.readdir(renamed)).sort()).toEqual(['login.csv', 'login.yml'])
    expect(await fs.readFile(path.join(renamed, 'login.yml'), 'utf8')).toContain('id: login\n')
    expect(await exists(path.join(root, 'collections/auth'))).toBe(false)
  })

  it('changes only the case of a name', async () => {
    const root = await project('folder-case', 'auth/login', false)
    await renameCollectionsFolder(root, 'auth', 'Auth')
    expect(await fs.readdir(path.join(root, 'collections'))).toEqual(['Auth'])
  })

  it('refuses a name another folder has in any case, and a folder that is not there', async () => {
    const root = await project('folder-taken', 'auth/login', false)
    await fs.mkdir(path.join(root, 'collections/Billing'))
    await expect(renameCollectionsFolder(root, 'auth', 'billing')).rejects.toThrow(
      'There is already a folder called "Billing"'
    )
    await expect(renameCollectionsFolder(root, 'auth', 'a:b')).rejects.toThrow('cannot contain')
    await expect(renameCollectionsFolder(root, 'nope', 'other')).rejects.toThrow(
      'There is no folder called "nope" in collections/'
    )
    // A path is not a folder's name.
    await expect(renameCollectionsFolder(root, '../auth', 'other')).rejects.toThrow(
      'cannot contain'
    )
    expect(await exists(path.join(root, 'collections/auth/login.yml'))).toBe(true)
  })
})

describe('moveCollectionToFolder', () => {
  it('moves a collection and its data file to another folder, and back to the root', async () => {
    const root = await project('to-folder', 'auth/login')
    await fs.mkdir(path.join(root, 'collections/billing'))
    const moved = await moveCollectionToFolder(
      root,
      path.join(root, 'collections/auth/login.yml'),
      'billing'
    )
    expect(moved).toBe(path.join(root, 'collections/billing/login.yml'))
    expect((await fs.readdir(path.join(root, 'collections/billing'))).sort()).toEqual([
      'login.csv',
      'login.yml'
    ])
    expect(await fs.readdir(path.join(root, 'collections/auth'))).toEqual([])
    // Its text is left as it was: the id never names the folder.
    expect(await fs.readFile(moved, 'utf8')).toContain('# kept as written\nid: login\n')

    const back = await moveCollectionToFolder(root, moved, null)
    expect(back).toBe(path.join(root, 'collections/login.yml'))
    expect(await exists(path.join(root, 'collections/login.csv'))).toBe(true)
  })

  it('refuses the folder it is in, one that is not there, and a file in the way', async () => {
    const root = await project('to-folder-refused', 'auth/login', false)
    const file = path.join(root, 'collections/auth/login.yml')
    await expect(moveCollectionToFolder(root, file, 'auth')).rejects.toThrow(
      'login.yml is in auth/ already'
    )
    await expect(moveCollectionToFolder(root, file, 'nope')).rejects.toThrow(
      'There is no folder called "nope" in collections/'
    )
    await write(path.join(root, 'collections/billing/login.yml'), 'id: login\nsteps: []\n')
    await expect(moveCollectionToFolder(root, file, 'billing')).rejects.toThrow(
      'collections/billing/login.yml already exists'
    )
    expect(await exists(file)).toBe(true)
  })
})
