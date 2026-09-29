import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCollection } from '../format/index.js'
import { loadCollection, loadProjectCollections } from './collection.js'
import { duplicateIds, idOfFile, idProblem } from './ids.js'
import { createCollectionFile } from './projectEdits.js'

let tmp: string

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-ids-')))
})

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

describe('idProblem', () => {
  const file = '/p/collections/checkout/sessions.yml'

  it('accepts an id that is the file name', () => {
    expect(idOfFile(file)).toBe('sessions')
    expect(idProblem({ id: 'sessions' }, file)).toBeNull()
  })

  it('asks for a missing id, naming the one to write', () => {
    expect(idProblem({}, file)).toBe(
      'id: missing — a collection file says its id, its file name: id: sessions (SPEC.md §2)'
    )
  })

  it('refuses an id that is not the file name, even by case', () => {
    expect(idProblem({ id: 'session' }, file)).toContain(
      'id: session does not match the file name, sessions.yml'
    )
    expect(idProblem({ id: 'Sessions' }, file)).toContain('does not match the file name')
  })

  it('refuses a file name that cannot be an id', () => {
    expect(idProblem({ id: 'my sessions' }, '/p/collections/my sessions.yml')).toContain(
      'an id is letters, digits and - _ .'
    )
  })
})

describe('duplicateIds', () => {
  it('finds ids shared across directories, ignoring case, naming the others', () => {
    const home = '/p/collections'
    const problems = duplicateIds(
      [`${home}/login.yml`, `${home}/auth/Login.yml`, `${home}/auth/logout.yml`],
      home
    )
    expect([...problems.keys()]).toEqual([`${home}/login.yml`, `${home}/auth/Login.yml`])
    expect(problems.get(`${home}/login.yml`)).toBe(
      'id: login is also the id of collections/auth/Login.yml — an id is unique in collections/, ignoring case (SPEC.md §2)'
    )
    expect(problems.get(`${home}/auth/Login.yml`)).toContain('also the id of collections/login.yml')
  })
})

describe('loading collections', () => {
  it('marks both collections that share an id', async () => {
    const root = path.join(tmp, 'dupes')
    await write(path.join(root, 'collections', 'login.yml'), 'id: login\nsteps: []\n')
    await write(path.join(root, 'collections', 'auth', 'login.yml'), 'id: login\nsteps: []\n')
    await write(path.join(root, 'collections', 'other.yml'), 'id: other\nsteps: []\n')
    const loaded = await loadProjectCollections(root)
    const problemsOf = (relativePath: string) =>
      loaded.find((c) => c.relativePath === relativePath)?.problems.map((p) => p.message)
    expect(problemsOf('login.yml')).toEqual([
      'id: login is also the id of collections/auth/login.yml — an id is unique in collections/, ignoring case (SPEC.md §2)'
    ])
    expect(problemsOf('auth/login.yml')?.[0]).toContain('also the id of collections/login.yml')
    expect(problemsOf('other.yml')).toEqual([])
  })

  it('keeps the doc of a collection whose id is wrong, so it can be fixed', async () => {
    const root = path.join(tmp, 'wrong')
    const file = path.join(root, 'collections', 'renamed.yml')
    await write(file, 'id: original\nsteps:\n  - GET: http://x\n')
    const loaded = await loadCollection(file, root)
    expect(loaded.name).toBe('renamed')
    expect(loaded.doc.id).toBe('original')
    expect(loaded.doc.steps).toHaveLength(1)
    expect(loaded.problems.map((p) => p.message)).toEqual([
      'id: original does not match the file name, renamed.yml — they must be the same (SPEC.md §2)'
    ])
  })
})

describe('createCollectionFile', () => {
  it('refuses an id another file in the home has, in any directory or case', async () => {
    const root = path.join(tmp, 'create')
    await createCollectionFile(root, 'auth', 'Login')
    await expect(createCollectionFile(root, null, 'login')).rejects.toThrow(
      'collections/auth/Login.yml already has the id login'
    )
    await expect(createCollectionFile(root, 'other', 'LOGIN')).rejects.toThrow(
      'already has the id LOGIN'
    )
    // Another home is another namespace.
    await expect(createCollectionFile(root, null, 'login', 'set')).resolves.toMatchObject({
      source: 'id: login\nparams: {}\nsteps: []\n'
    })
  })
})

describe('parseCollection', () => {
  it('says name: is now id:', () => {
    expect(() => parseCollection('name: Checkout\nsteps: []\n')).toThrow(
      'name: is now id:, the collection file name without .yml (SPEC.md §2)'
    )
  })
})
