import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildScope } from '../vars/resolve.js'
import { loadCollection, summarize } from './collection.js'
import {
  directoryOf,
  discoverProject,
  projectEnvironments,
  projectRootFor,
  projectRootOf,
  readProject
} from './project.js'

let tmp: string
let shop: string
let shared: string

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}
const collection = (id: string) => `id: ${id}\nsteps:\n  - GET: "http://x/{{path}}"\n`

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-project-')))
  shop = path.join(tmp, 'repo', 'services', 'shop')
  shared = path.join(tmp, 'repo', 'shared')

  await write(path.join(shop, 'collections', 'smoke.yml'), collection('smoke'))
  await write(path.join(shop, 'collections', 'checkout', 'sessions.yml'), collection('sessions'))
  await write(path.join(shop, 'collections', 'checkout', 'deeper', 'lost.yml'), collection('lost'))
  await fs.mkdir(path.join(shop, 'collections', 'orders'), { recursive: true })
  await write(path.join(shop, 'collections', '.hidden', 'x.yml'), collection('x'))
  await write(path.join(shop, 'collections', 'notes.txt'), 'not a collection')
  await write(
    path.join(shop, 'project.yml'),
    'name: Shop\nuses: ../../shared\nvars:\n  region: eu\n  tier: project\n'
  )
  await write(
    path.join(shop, 'environments', 'demo.yml'),
    'name: demo\nvars:\n  path: from-project\n'
  )
  await write(
    path.join(shared, 'project.yml'),
    'name: Shared\nvars:\n  tier: global\n  owner: platform\n'
  )
  await write(
    path.join(shared, 'environments', 'demo.yml'),
    'name: demo\nvars:\n  path: from-global\n  host: shared.test\n  token: { secret: true }\n'
  )
  await write(
    path.join(shared, 'environments', 'staging.yml'),
    'name: staging\nvars:\n  host: staging.test\n'
  )
  await write(path.join(shared, '.env'), 'token=from-shared-dotenv\n')
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('where a project is', () => {
  it('is the folder picked, or the one holding a picked collections/', async () => {
    expect(await projectRootFor(shop)).toBe(shop)
    expect(await projectRootFor(path.join(shop, 'collections'))).toBe(shop)
  })

  it('is found from a collection in two steps, never by walking further', () => {
    expect(projectRootOf(path.join(shop, 'collections', 'smoke.yml'))).toBe(shop)
    expect(projectRootOf(path.join(shop, 'collections', 'checkout', 'sessions.yml'))).toBe(shop)
    expect(projectRootOf(path.join(shop, 'collections', 'a', 'b', 'c.yml'))).toBeNull()
    expect(directoryOf(path.join(shop, 'collections', 'smoke.yml'))).toBeNull()
    expect(directoryOf(path.join(shop, 'collections', 'checkout', 'sessions.yml'))).toBe('checkout')
  })
})

describe('discoverProject', () => {
  it('reads collections/ and one directory down, empty directories included', async () => {
    const layout = await discoverProject(shop)
    expect(layout.files).toEqual([
      path.join(shop, 'collections', 'checkout', 'sessions.yml'),
      path.join(shop, 'collections', 'smoke.yml')
    ])
    expect(layout.directories).toEqual(['checkout', 'orders'])
  })

  it('reports a directory nested deeper instead of reading it', async () => {
    const layout = await discoverProject(shop)
    expect(layout.problems).toEqual([
      expect.objectContaining({
        path: 'checkout/deeper',
        message: expect.stringContaining('one level deep')
      })
    ])
  })

  it('finds nothing, without failing, when there is no collections/', async () => {
    const layout = await discoverProject(path.join(tmp, 'nowhere'))
    expect(layout.files).toEqual([])
    expect(layout.problems).toEqual([])
  })

  it('writes a collection’s place with /, on every platform', async () => {
    const loaded = await loadCollection(
      path.join(shop, 'collections', 'checkout', 'sessions.yml'),
      shop
    )
    expect(summarize(loaded)).toMatchObject({
      relativePath: 'checkout/sessions.yml',
      directory: 'checkout',
      name: 'sessions',
      excluded: false,
      problems: [],
      environmentsPath: path.join(shop, 'environments')
    })
  })
})

describe('project.yml and its global project', () => {
  it('reads the project and follows uses to the global project', async () => {
    const info = await readProject(shop)
    expect(info.doc?.name).toBe('Shop')
    expect(info.global).toMatchObject({ root: shared, uses: '../../shared' })
    expect(info.problems).toEqual([])
  })

  it('reads a uses written with backslashes the same way', async () => {
    const other = path.join(tmp, 'repo', 'services', 'backslash')
    await write(path.join(other, 'project.yml'), 'uses: ..\\..\\shared\n')
    expect((await readProject(other)).global?.root).toBe(shared)
  })

  it('refuses an absolute uses, and one that is not a project', async () => {
    const absolute = path.join(tmp, 'absolute')
    await write(path.join(absolute, 'project.yml'), `uses: ${shared.replace(/\\/g, '/')}\n`)
    expect((await readProject(absolute)).problems[0]?.message).toMatch(/relative path/)

    const nowhere = path.join(tmp, 'nowhere-uses')
    await write(path.join(nowhere, 'project.yml'), 'uses: ../repo\n')
    expect((await readProject(nowhere)).problems[0]?.message).toMatch(/no project.yml there/)
  })

  it('refuses a global project that uses another', async () => {
    const chain = path.join(tmp, 'chain')
    await write(path.join(chain, 'a', 'project.yml'), 'uses: ../b\n')
    await write(path.join(chain, 'b', 'project.yml'), 'uses: ../c\n')
    await write(path.join(chain, 'c', 'project.yml'), 'name: c\n')
    const info = await readProject(path.join(chain, 'a'))
    expect(info.global).toBeNull()
    expect(info.problems[0]?.message).toMatch(/cannot use another/)
  })

  it('lists the project’s environments and the global project’s', async () => {
    const info = await readProject(shop)
    const environments = await projectEnvironments(shop, info.global)
    expect(environments.map((e) => `${e.source}:${e.name}`)).toEqual([
      'project:demo',
      'global:demo',
      'global:staging'
    ])
  })
})

describe('variables across a project and its global project', () => {
  const scopeFor = (environmentName: string | null, env: Record<string, string> = {}) =>
    buildScope({
      collectionPath: path.join(shop, 'collections', 'smoke.yml'),
      environmentName,
      env
    })

  it('layers global, project, then environment — the project’s over the global’s', async () => {
    const scope = await scopeFor('demo')
    expect(scope.get('owner')).toBe('platform')
    expect(scope.get('tier')).toBe('project')
    expect(scope.get('region')).toBe('eu')
    expect(scope.get('path')).toBe('from-project')
    expect(scope.get('host')).toBe('shared.test')
    expect(scope.originOf('owner')).toBe('../../shared/project.yml')
    expect(scope.originOf('path')).toBe('environments/demo.yml')
    expect(scope.originOf('host')).toBe('../../shared/environments/demo.yml')
  })

  it('offers an environment only the global project has', async () => {
    expect((await scopeFor('staging')).get('host')).toBe('staging.test')
  })

  it('finds a shared secret in the process environment, then either .env', async () => {
    expect((await scopeFor('demo')).get('token')).toBe('from-shared-dotenv')
    expect((await scopeFor('demo', { token: 'from-env' })).get('token')).toBe('from-env')
    await write(path.join(shop, '.env'), 'token=from-project-dotenv\n')
    expect((await scopeFor('demo')).get('token')).toBe('from-project-dotenv')
  })

  it('uses project variables as edited, over the saved ones', async () => {
    const scope = await buildScope({
      collectionPath: path.join(shop, 'collections', 'smoke.yml'),
      projectVars: { region: 'us' },
      env: {}
    })
    expect(scope.get('region')).toBe('us')
    expect(scope.has('owner')).toBe(true)
  })
})

describe('editing a project', () => {
  it('creates project.yml on the first edit, uses written with /', async () => {
    const { applyProjectEdits } = await import('./projectEdits.js')
    const root = path.join(tmp, 'fresh')
    await fs.mkdir(root, { recursive: true })
    const created = await applyProjectEdits(root, null, [
      { key: 'vars', value: { a: 1 } },
      { key: 'uses', value: '..\\shared' }
    ])
    expect(created).toEqual({ ok: true, source: 'uses: ../shared\nvars:\n  a: 1\n', wrote: true })
    const again = await applyProjectEdits(root, null, [{ key: 'name', value: 'x' }])
    expect(again).toMatchObject({ ok: false, conflict: true })
  })

  it('edits it in place, keeping comments', async () => {
    const { applyProjectEdits } = await import('./projectEdits.js')
    const root = path.join(tmp, 'commented')
    const source = '# ours\nname: Ours # the display name\nvars:\n  a: 1\n'
    await write(path.join(root, 'project.yml'), source)
    const edited = await applyProjectEdits(root, source, [{ key: 'uses', value: '../shared' }])
    expect(edited).toMatchObject({
      ok: true,
      source: '# ours\nname: Ours # the display name\nuses: ../shared\nvars:\n  a: 1\n'
    })
  })

  it('refuses an absolute uses', async () => {
    const { editProjectSource } = await import('./projectEdits.js')
    expect(() => editProjectSource('name: x\n', [{ key: 'uses', value: 'C:/shared' }])).toThrow(
      /relative path/
    )
  })

  it('makes directories and collections, with names Windows accepts', async () => {
    const { createCollectionFile: createCollection, createDirectory } =
      await import('./projectEdits.js')
    const root = path.join(tmp, 'made')
    await createDirectory(root, 'Orders')
    await expect(createDirectory(root, 'Orders')).rejects.toThrow('already a directory')
    await expect(createDirectory(root, 'a/b')).rejects.toThrow('cannot contain')
    const made = await createCollection(root, 'Orders', 'place-an-order')
    expect(made.path).toBe(path.join(root, 'collections', 'Orders', 'place-an-order.yml'))
    expect(made.source).toBe('id: place-an-order\nsteps: []\n')
    await expect(createCollection(root, 'Orders', 'place-an-order')).rejects.toThrow(
      'collections/Orders/place-an-order.yml already has the id place-an-order'
    )
    await expect(createCollection(root, null, 'Place an order')).rejects.toThrow(
      'An id is letters, digits and - _ .'
    )
    expect((await discoverProject(root)).files).toEqual([made.path])
  })
})
