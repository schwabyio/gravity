import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BodyFileError, prepareRequest } from './run/prepareRequest.js'
import { buildScope } from './vars/resolve.js'
import { VariableScope } from './vars/scope.js'
import { createEnvironmentFile } from './workspace/environmentEdits.js'
import { idProblem } from './workspace/ids.js'
import { loadChecks, resolveRequestSet } from './workspace/library.js'
import { discoverProject, portableNameProblems, readProject } from './workspace/project.js'
import { createDirectory } from './workspace/projectEdits.js'
import { loadProjectTls } from './workspace/projectTls.js'

/**
 * One project, read the same on macOS, Windows and Linux (SPEC.md §1.2). These
 * run on every platform: what a case-insensitive disk would quietly find is
 * reported everywhere, and Windows' case-insensitive environment is simulated.
 */

let tmp: string
let shop: string
/** True where `Probe` and `probe` are two names: Linux, usually. */
let caseSensitive: boolean

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-portable-')))
  shop = path.join(tmp, 'services', 'shop')
  await write(path.join(shop, 'collections', 'smoke.yml'), 'id: smoke\nsteps: []\n')
  await write(path.join(shop, 'requests', 'auth', 'login.yml'), 'id: login\nsteps: []\n')
  await write(path.join(shop, 'files', 'order.json'), '{}')
  await write(path.join(shop, 'certs', 'root.pem'), '')
  await write(path.join(tmp, 'shared', 'project.yml'), 'name: Shared\n')
  await write(path.join(tmp, 'Probe'), '')
  caseSensitive = await fs.access(path.join(tmp, 'probe')).then(
    () => false,
    () => true
  )
})

afterAll(() => fs.rm(tmp, { recursive: true, force: true }))

describe('a name spelled in another case than on disk', () => {
  const differs = /spelled in a different case on disk, as .*: names must match exactly/

  it('is refused in use:, where macOS and Windows would find it and Linux would not', async () => {
    await expect(resolveRequestSet(shop, null, 'Auth/login')).rejects.toThrow(
      /^use: Auth\/login — Auth\/login\.yml is spelled in a different case on disk, as auth\/login\.yml/
    )
    await expect(resolveRequestSet(shop, null, 'auth/nope')).rejects.toThrow('there is no')
  })

  it('is a problem in uses:, tls.ca and a body file', async () => {
    const project = path.join(tmp, 'services', 'cased')
    await write(path.join(project, 'project.yml'), 'uses: ../../Shared\n')
    const info = await readProject(project)
    expect(info.global).toBeNull()
    expect(info.problems[0]?.message).toMatch(/^uses: \.\.\/\.\.\/Shared is spelled/)

    const trust = await loadProjectTls(shop, {
      doc: { tls: { ca: ['certs/Root.pem'] } },
      global: null
    })
    expect(trust.problems[0]?.message).toMatch(differs)

    const request = { method: 'POST', url: 'http://x', headers: [], body: null }
    const sent = prepareRequest(request, { file: 'files/Order.json' }, new VariableScope(), {
      project: shop,
      global: null
    })
    await expect(sent).rejects.toThrow(BodyFileError)
    await expect(sent).rejects.toThrow(/^body\.file: files\/Order\.json is spelled/)
  })

  it('names no environment: the file name is matched exactly', async () => {
    const project = path.join(tmp, 'services', 'envs')
    await write(path.join(project, 'collections', 'a.yml'), 'id: a\nsteps: []\n')
    await write(path.join(project, 'environments', 'staging.yml'), 'vars: { region: eu }\n')
    const collectionPath = path.join(project, 'collections', 'a.yml')
    const scope = await buildScope({ collectionPath, environmentName: 'staging', env: {} })
    expect(scope.get('region')).toBe('eu')
    await expect(
      buildScope({ collectionPath, environmentName: 'Staging', env: {} })
    ).rejects.toThrow('Environment "Staging" was not found')
  })

  it('is reported for a folder gta looks for, such as Collections/', async () => {
    const project = path.join(tmp, 'services', 'capital')
    await write(path.join(project, 'Collections', 'a.yml'), 'id: a\nsteps: []\n')
    const layout = await discoverProject(project)
    expect(layout.problems).toContainEqual({
      path: 'Collections',
      message:
        'must be named collections: macOS and Windows read it as it is, Linux does not (SPEC.md §1.2)'
    })
  })

  it('is reported for a file gta reads at the root, such as Rules.yml', async () => {
    const project = path.join(tmp, 'services', 'ruled')
    await write(path.join(project, 'collections', 'a.yml'), 'id: a\nsteps: []\n')
    await write(path.join(project, 'Rules.yml'), 'ids:\n  collections: kebab-case\n')
    const layout = await discoverProject(project)
    expect(layout.problems).toContainEqual({
      path: 'Rules.yml',
      message:
        'must be named rules.yml: macOS and Windows read it as it is, Linux does not (SPEC.md §1.2)'
    })
  })
})

describe('names a checkout on another platform could not hold', () => {
  it('refuses a collection file Windows refuses, such as aux.yml', () => {
    expect(idProblem({ id: 'aux' }, '/p/collections/aux.yml')).toBe(
      'aux.yml: "aux.yml" is reserved on Windows (SPEC.md §1.2)'
    )
    expect(idProblem({ id: 'auxiliary' }, '/p/collections/auxiliary.yml')).toBeNull()
  })

  it('reports names in one directory that differ only in case, or that Windows refuses', () => {
    expect(portableNameProblems('collections', ['Checkout', 'checkout', 'orders', 'con'])).toEqual([
      {
        path: 'collections/con',
        message: '"con" is reserved on Windows (SPEC.md §1.2)'
      },
      {
        path: 'collections/Checkout',
        message:
          'differs only in case from collections/checkout: a macOS or Windows checkout can hold only one of them (SPEC.md §1.2)'
      },
      {
        path: 'collections/checkout',
        message:
          'differs only in case from collections/Checkout: a macOS or Windows checkout can hold only one of them (SPEC.md §1.2)'
      }
    ])
  })

  it('finds them on a case-sensitive disk', async (context) => {
    if (!caseSensitive) context.skip()
    const project = path.join(tmp, 'services', 'twins')
    await write(path.join(project, 'collections', 'Checkout', 'a.yml'), 'id: a\nsteps: []\n')
    await write(path.join(project, 'collections', 'checkout', 'b.yml'), 'id: b\nsteps: []\n')
    await write(path.join(project, 'environments', 'Staging.yml'), 'vars: {}\n')
    await write(path.join(project, 'environments', 'staging.yml'), 'vars: {}\n')
    const paths = (await discoverProject(project)).problems.map((problem) => problem.path)
    expect(paths).toEqual(
      expect.arrayContaining([
        'collections/Checkout',
        'collections/checkout',
        'environments/Staging.yml',
        'environments/staging.yml'
      ])
    )
  })

  it('makes no directory or environment that differs only in case from one there', async () => {
    const project = path.join(tmp, 'services', 'making')
    await fs.mkdir(path.join(project, 'collections', 'checkout'), { recursive: true })
    await expect(createDirectory(project, 'Checkout')).rejects.toThrow(
      'There is already a folder called "checkout"'
    )
    await write(path.join(project, 'environments', 'Staging.yml'), 'vars: {}\n')
    await expect(
      createEnvironmentFile(path.join(project, 'environments'), 'staging')
    ).rejects.toThrow('environments/Staging.yml already exists')
  })
})

describe('the process environment', () => {
  /** `process.env` as Windows has it: a name is looked up ignoring case. */
  const windowsEnv = (vars: Record<string, string>) =>
    new Proxy(vars, {
      get: (target, name) =>
        typeof name === 'string'
          ? Object.entries(target).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1]
          : undefined
    })

  it('overrides only a variable of exactly its name', () => {
    const env = windowsEnv({ Path: 'C:\\Windows', region: 'us' })
    const scope = new VariableScope(
      [{ source: 'x.yml', vars: { path: 'users', region: 'eu' } }],
      env
    )
    expect(scope.get('path')).toBe('users')
    expect(scope.get('region')).toBe('us')
  })

  it('gives a secret its own value, not a system variable of another case', async () => {
    const project = path.join(tmp, 'services', 'secrets')
    await write(path.join(project, 'collections', 'a.yml'), 'id: a\nsteps: []\n')
    await write(
      path.join(project, 'environments', 'local.yml'),
      'vars:\n  username: { secret: true }\n'
    )
    await write(path.join(project, '.env'), 'username=tester\n')
    const scope = await buildScope({
      collectionPath: path.join(project, 'collections', 'a.yml'),
      environmentName: 'local',
      env: windowsEnv({ USERNAME: 'dave' })
    })
    expect(scope.get('username')).toBe('tester')
  })
})

describe('check files', () => {
  it('are read without the byte order mark a Windows editor may add', async () => {
    const project = path.join(tmp, 'services', 'checks')
    await write(path.join(project, 'checks', 'paging.js'), '\ufeffexport function ok() {}\n')
    const [paging] = await loadChecks(project, null)
    expect(paging?.code).toBe('export function ok() {}\n')
  })
})
