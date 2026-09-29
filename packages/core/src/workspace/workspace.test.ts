import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitRepo, isClean, runGit } from '../git/index.js'
import { flattenCollections, groupByDirectory, type CollectionSummary } from '../model/tree.js'
import { isInside } from '../paths.js'
import { collectionsDirOf, discoverCollections } from './discover.js'

/**
 * These build real git repositories in a temp directory rather than mocking git.
 * Discovery leans on `git ls-files` semantics — tracked plus untracked minus
 * ignored — and only the real thing proves we read them correctly.
 */

let tmp: string
let flat: string
let monorepo: string
let plain: string

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

const collection = (id: string, ...steps: string[]) =>
  `id: ${id}\nsteps:\n${steps.map((s) => `  - name: ${s}\n    GET: "https://example.test/${s}"\n`).join('')}`

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true })
  await runGit(['init', '--initial-branch=main'], { cwd: dir })
  await runGit(['config', 'user.email', 'test@example.test'], { cwd: dir })
  await runGit(['config', 'user.name', 'Test'], { cwd: dir })
}

const commitAll = async (dir: string, message: string) => {
  await runGit(['add', '-A'], { cwd: dir })
  await runGit(['commit', '-m', message, '--no-gpg-sign'], { cwd: dir })
}

beforeAll(async () => {
  // macOS hands back a /var path that is really /private/var; git reports the
  // real one, so the fixtures use real paths throughout.
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-workspace-')))

  flat = path.join(tmp, 'payments-api')
  await initRepo(flat)
  await write(path.join(flat, '.gitignore'), 'node_modules/\n')
  await write(path.join(flat, 'collections', 'smoke.yml'), collection('smoke', 'ping'))
  await write(
    path.join(flat, 'collections', 'checkout', 'sessions.yml'),
    collection('sessions', 'create', 'capture')
  )
  await write(
    path.join(flat, 'collections', 'checkout', 'refunds.yml'),
    collection('refunds', 'full')
  )
  await write(
    path.join(flat, 'environments', 'demo.yml'),
    'name: demo\nvars:\n  baseUrl: https://example.test\n'
  )
  // Not collections: no top-level `steps` list.
  await write(path.join(flat, 'docker-compose.yml'), 'services:\n  api:\n    image: x\n')
  await write(path.join(flat, '.github', 'workflows', 'ci.yml'), 'jobs:\n  build:\n    steps: []\n')
  await write(
    path.join(flat, 'node_modules', 'dep', 'collections', 'thing.yml'),
    collection('thing', 'x')
  )
  await commitAll(flat, 'initial')

  monorepo = path.join(tmp, 'platform')
  await initRepo(monorepo)
  await write(
    path.join(monorepo, 'services', 'auth', 'collections', 'login.yml'),
    collection('login', 'post-login')
  )
  await write(
    path.join(monorepo, 'services', 'users', 'collections', 'users.yml'),
    collection('users', 'get-user')
  )
  await commitAll(monorepo, 'initial')
  // Untracked but not ignored, so still discoverable.
  await write(
    path.join(monorepo, 'services', 'billing', 'collections', 'billing.yml'),
    collection('billing', 'invoice')
  )

  plain = path.join(tmp, 'plain')
  await write(path.join(plain, 'collections', 'a.yml'), collection('a', 'one'))
  await write(path.join(plain, 'node_modules', 'x', 'collections', 'b.yml'), collection('b', 'x'))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('discoverCollections', () => {
  it('finds collections under collections/, at any depth', async () => {
    const dirs = await discoverCollections(flat)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]?.path).toBe(path.join(flat, 'collections'))
    expect(dirs[0]?.scope).toBe('')
    expect(dirs[0]?.files).toEqual([
      path.join(flat, 'collections', 'checkout', 'refunds.yml'),
      path.join(flat, 'collections', 'checkout', 'sessions.yml'),
      path.join(flat, 'collections', 'smoke.yml')
    ])
  })

  it('never looks at YAML outside collections/', async () => {
    const files = (await discoverCollections(flat)).flatMap((dir) => dir.files)
    // A compose file, a workflow with a nested `steps:` key, and environments.
    expect(files.some((f) => f.endsWith('docker-compose.yml'))).toBe(false)
    expect(files.some((f) => f.includes('.github'))).toBe(false)
    expect(files.some((f) => f.includes('environments'))).toBe(false)
  })

  it('never returns a file .gitignore covers', async () => {
    const files = (await discoverCollections(flat)).flatMap((dir) => dir.files)
    expect(files.some((f) => f.includes('node_modules'))).toBe(false)
  })

  it('keeps each service\u2019s collections/ separate in a monorepo', async () => {
    const dirs = await discoverCollections(monorepo)
    expect(dirs.map((dir) => dir.scope)).toEqual([
      path.join('services', 'auth'),
      path.join('services', 'billing'),
      path.join('services', 'users')
    ])
    expect(dirs[0]?.files).toEqual([
      path.join(monorepo, 'services', 'auth', 'collections', 'login.yml')
    ])
  })

  it('scopes discovery to a subdirectory of a repo', async () => {
    const dirs = await discoverCollections(path.join(monorepo, 'services', 'auth'))
    expect(dirs.map((dir) => dir.scope)).toEqual([''])
  })

  it('falls back to a directory walk outside a repository', async () => {
    const dirs = await discoverCollections(plain)
    expect(dirs.flatMap((dir) => dir.files)).toEqual([path.join(plain, 'collections', 'a.yml')])
  })

  it('finds nothing in a workspace with no collections/ directory', async () => {
    const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'api-bare-'))
    await fs.writeFile(path.join(bare, 'thing.yml'), 'steps: []\n')
    expect(await discoverCollections(bare)).toEqual([])
    await fs.rm(bare, { recursive: true, force: true })
  })
})

describe('collectionsDirOf', () => {
  it('finds the nearest ancestor named collections', () => {
    expect(collectionsDirOf('/w/collections/a/b.yml')).toBe('/w/collections')
    expect(collectionsDirOf('/w/svc/collections/b.yml')).toBe('/w/svc/collections')
  })

  it('returns null when there is none', () => {
    expect(collectionsDirOf('/w/a/b.yml')).toBeNull()
  })
})

describe('groupByDirectory', () => {
  const summary = (relativePath: string, name: string): CollectionSummary => ({
    path: `/w/collections/${relativePath}`,
    relativePath,
    directory: relativePath.includes('/') ? relativePath.split('/')[0]! : null,
    name,
    stepCount: 1,
    tags: [],
    environmentsPath: null,
    problems: []
  })

  it('puts directories first, then the collections at the root', () => {
    const nodes = groupByDirectory([
      summary('smoke.yml', 'smoke'),
      summary('checkout/sessions.yml', 'sessions')
    ])
    expect(nodes.map((n) => (n.kind === 'directory' ? `dir:${n.name}` : n.summary.name))).toEqual([
      'dir:checkout',
      'smoke'
    ])
  })

  it('groups several collections under one directory, by name', () => {
    const nodes = groupByDirectory([
      summary('checkout/sessions.yml', 'sessions'),
      summary('checkout/refunds.yml', 'refunds')
    ])
    expect(nodes).toHaveLength(1)
    if (nodes[0]?.kind !== 'directory') throw new Error('expected a directory')
    expect(nodes[0].children.map((c) => (c.kind === 'collection' ? c.summary.name : ''))).toEqual([
      'refunds',
      'sessions'
    ])
  })

  it('shows a directory with nothing in it yet', () => {
    const nodes = groupByDirectory([summary('smoke.yml', 'smoke')], ['orders', 'checkout'])
    expect(nodes.map((n) => (n.kind === 'directory' ? `dir:${n.name}` : n.summary.name))).toEqual([
      'dir:checkout',
      'dir:orders',
      'smoke'
    ])
  })

  it('returns collections in display order when flattened', () => {
    const nodes = groupByDirectory([
      summary('smoke.yml', 'smoke'),
      summary('checkout/sessions.yml', 'sessions'),
      summary('checkout/refunds.yml', 'refunds')
    ])
    expect(flattenCollections(nodes).map((c) => c.name)).toEqual(['refunds', 'sessions', 'smoke'])
  })
})

describe('GitRepo', () => {
  it('resolves the working tree root and git dir', async () => {
    const repo = await GitRepo.open(path.join(flat, 'collections'))
    expect(repo?.root).toBe(flat)
    expect(repo?.gitDir.endsWith('.git')).toBe(true)
  })

  it('returns null outside a repository', async () => {
    expect(await GitRepo.open(plain)).toBeNull()
  })

  it('reports a clean tree and its branch', async () => {
    const status = await (await GitRepo.open(flat))!.status()
    expect(status.branch).toBe('main')
    expect(isClean(status)).toBe(true)
  })

  it('refuses to pull a branch with no upstream', async () => {
    await expect((await GitRepo.open(flat))!.pull()).rejects.toThrow(/no upstream/)
  })
})

describe('isInside', () => {
  it('accepts a directory and its descendants, rejects siblings', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/c')).toBe(false)
  })
})
