import fs from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { collection, makeProject, startServer } from '../testProject.js'
import { openProject } from './project.js'
import type { RunResult, StepRef } from './types.js'

let server: Awaited<ReturnType<typeof startServer>>
beforeAll(async () => {
  server = await startServer()
})
afterAll(() => server.close())

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>) {
  const root = await makeProject({
    'settings.yml': 'environmentType: local\n',
    'environments/local.yml': `name: local\nvars:\n  baseUrl: ${server.origin}\n`,
    ...files
  })
  roots.push(root)
  return root
}

/** A request set that logs in as `params.user`, saving what the server echoed as `seen`. */
const LOGIN = [
  'id: login',
  'params:',
  '  user: { required: true }',
  '  expect: 200',
  'steps:',
  '  - name: log in',
  "    GET: '{{baseUrl}}/ok/{{params.user}}'",
  '    tests: |',
  '      gta.expectResponseStatusCodeToBe(params.expect)',
  "      gta.expectResponseBodyToHaveProperty('url', 'seen', 'setAsCollectionVariable')",
  ''
].join('\n')

describe('openProject', () => {
  it('opens a project with its settings, environments and collections', async () => {
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok']),
      'collections/checkout/sessions.yml': collection('sessions', ['/ok'])
    })
    const opened = await openProject(root)
    expect(opened.root).toBe(await fs.realpath(root))
    expect(opened.environment).toBe('local')
    expect(opened.environments).toEqual(['local'])
    expect([...opened.collections].sort()).toEqual(['sessions', 'smoke'])
  })

  it('needs no settings.yml, as gta does', async () => {
    const root = await project({ 'collections/smoke.yml': collection('smoke', ['/ok']) })
    await fs.rm(path.join(root, 'settings.yml'))
    const opened = await openProject(root, { environment: 'local' })
    expect(opened.environment).toBe('local')
    expect((await opened.run('smoke')).passed).toBe(true)
  })

  it('refuses a folder that is not a project, and an environment it does not have', async () => {
    const root = await project({ 'collections/smoke.yml': collection('smoke', ['/ok']) })
    await expect(openProject(path.join(root, 'environments'))).rejects.toThrow(
      /is not a Gravity project: it has no collections\/ folder/
    )
    await expect(openProject(root, { environment: 'prod' })).rejects.toThrow(
      'environmentType (from the environment option): there is no environment called "prod". This project has: local'
    )
  })
})

describe('run', () => {
  it('runs a collection by id or place, and says it passed', async () => {
    const root = await project({
      'collections/checkout/sessions.yml': collection('sessions', ['/ok', '/ok'])
    })
    const opened = await openProject(root)
    for (const name of ['sessions', 'checkout/sessions', 'collections/checkout/sessions.yml']) {
      const outcome = await opened.run(name)
      expect(outcome).toMatchObject({ passed: true, id: 'sessions', error: null, failures: '' })
      expect(outcome.file).toBe(path.join(opened.root, 'collections', 'checkout', 'sessions.yml'))
      expect(outcome.summary).toMatchObject({ total: 2, passed: 2 })
    }
  })

  it('says what failed, as gta prints it', async () => {
    const root = await project({ 'collections/broken.yml': collection('broken', ['/ok', '/fail']) })
    const outcome = await (await openProject(root)).run('broken')
    expect(outcome.passed).toBe(false)
    expect(outcome.error).toBeNull()
    expect(outcome.summary).toMatchObject({ total: 2, passed: 1, failed: 1 })
    expect(outcome.failures).toContain('broken\n  ✗ get /fail 500')
    expect(outcome.failures).toContain('Status is 200: Expected 200, got 500')
  })

  it('rejects a name nothing answers to, saying what there is', async () => {
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok']),
      'collections/checkout/sessions.yml': collection('sessions', ['/ok'])
    })
    const opened = await openProject(root)
    await expect(opened.run('nope')).rejects.toThrow('No collection is called "nope".')
    await expect(opened.run('checkout')).rejects.toThrow(
      '"checkout" is a folder: run its collections one at a time.'
    )
  })

  it('runs the steps named, by name or place from 1, in the file’s order', async () => {
    const root = await project({ 'collections/three.yml': collection('three', ['/a', '/b', '/c']) })
    const opened = await openProject(root)
    const outcome = await opened.run('three', { steps: [3, 'get /a'] })
    expect(outcome.summary.results.map((r) => r.item.name)).toEqual(['get /a', 'get /c'])
    expect(outcome.steps.map((s) => s.index)).toEqual([0, 2])
    await expect(opened.run('three', { steps: ['get /d'] })).rejects.toThrow(
      'three has no step called "get /d". Its steps: "get /a", "get /b", "get /c"'
    )
    await expect(opened.run('three', { steps: [4] })).rejects.toThrow(
      'three has no step 4: its steps are 1 to 3'
    )
  })

  it('starts from the values given, and gives back every value the run set or captured', async () => {
    const root = await project({
      'collections/order.yml': [
        'id: order',
        'steps:',
        '  - name: place',
        "    GET: '{{baseUrl}}/ok/{{orderId}}'",
        '    tests: |',
        "      gta.expectResponseBodyToHaveProperty('url', 'placed', 'setAsCollectionVariable')",
        "      gta.set('count', 2)",
        ''
      ].join('\n')
    })
    const outcome = await (await openProject(root)).run('order', { vars: { orderId: 'o-7' } })
    expect(outcome.passed).toBe(true)
    expect(outcome.summary.results[0]?.request.url).toBe(`${server.origin}/ok/o-7`)
    expect(outcome.values).toEqual({ placed: '/ok/o-7', count: 2 })
  })

  it('refuses a value that is not plain data', async () => {
    const root = await project({ 'collections/smoke.yml': collection('smoke', ['/ok']) })
    const opened = await openProject(root)
    await expect(
      opened.run('smoke', { vars: { user: { id: 1 } as unknown as string } })
    ).rejects.toThrow('vars.user must be a string, number, boolean or null')
  })

  it('reports each result as it lands, with the line of its step', async () => {
    const root = await project({ 'collections/two.yml': collection('two', ['/a', '/b']) })
    const seen: Array<[RunResult, StepRef]> = []
    const outcome = await (
      await openProject(root)
    ).run('two', {
      onResult: (result, step) => seen.push([result, step])
    })
    expect(seen.map(([r]) => r.item.name)).toEqual(['get /a', 'get /b'])
    expect(seen.map(([, s]) => [path.basename(s.file), s.line])).toEqual([
      ['two.yml', 3],
      ['two.yml', 7]
    ])
    expect(outcome.steps).toEqual(seen.map(([, s]) => s))
  })

  it('runs once for each data row, setup and teardown around them', async () => {
    const root = await project({
      'collections/rows.yml': [
        'id: rows',
        'setup:',
        "  - GET: '{{baseUrl}}/ok/setup'",
        'steps:',
        "  - GET: '{{baseUrl}}/ok/{{who}}'",
        "    tests: gta.set('last', gta.get('who'))",
        ''
      ].join('\n'),
      'collections/rows.csv': 'who\nann\nbob\n'
    })
    const outcome = await (await openProject(root)).run('rows')
    expect(outcome.summary.results.map((r) => r.request.url.replace(server.origin, ''))).toEqual([
      '/ok/setup',
      '/ok/ann',
      '/ok/bob'
    ])
    expect(outcome.steps.map((s) => s.iteration?.index)).toEqual([undefined, 1, 2])
    expect(outcome.values).toEqual({ last: 'bob' })
  })

  it('hides secrets in results, but not in the values it gives back', async () => {
    const root = await project({
      'environments/local.yml': [
        'name: local',
        'vars:',
        `  baseUrl: ${server.origin}`,
        '  token: { secret: true }',
        ''
      ].join('\n'),
      'collections/secret.yml': [
        'id: secret',
        'steps:',
        "  - GET: '{{baseUrl}}/ok/{{token}}'",
        "    tests: gta.set('copy', gta.get('token'))",
        ''
      ].join('\n')
    })
    process.env.token = 'hush-123'
    try {
      const outcome = await (await openProject(root)).run('secret')
      expect(outcome.summary.results[0]?.request.url).toBe(`${server.origin}/ok/[secret: token]`)
      expect(outcome.values).toEqual({ copy: 'hush-123' })
    } finally {
      delete process.env.token
    }
  })

  it('stops a run at timeoutCollection, and one the caller cancels', async () => {
    const root = await project({ 'collections/slow.yml': collection('slow', ['/slow']) })
    const timed = await (await openProject(root, { timeoutCollection: 200 })).run('slow')
    expect(timed.passed).toBe(false)
    expect(timed.error).toBe('Timed out after 200 ms (timeoutCollection)')
    expect(timed.failures).toContain('✗ Timed out after 200 ms (timeoutCollection)')

    const cancel = new AbortController()
    setTimeout(() => cancel.abort(), 100)
    const cancelled = await (await openProject(root)).run('slow', { signal: cancel.signal })
    expect(cancelled.error).toBe('The run was cancelled')
  })

  it('reports a file that will not load, without running it', async () => {
    const root = await project({ 'collections/bad.yml': 'id: bad\nsteps: nope\n' })
    const outcome = await (await openProject(root)).run('bad')
    expect(outcome.passed).toBe(false)
    expect(outcome.error).toMatch(/steps/)
    expect(outcome.summary.results).toEqual([])
  })

  it('stops at the first failing step with bail, given or from the project', async () => {
    const root = await project({ 'collections/bails.yml': collection('bails', ['/fail', '/ok']) })
    const given = await (await openProject(root)).run('bails', { bail: true })
    expect(given.summary).toMatchObject({ total: 2, failed: 1, skipped: 1 })
    expect(given.summary.results).toHaveLength(1)
    const fromProject = await (await openProject(root, { bail: true })).run('bails')
    expect(fromProject.summary.results).toHaveLength(1)
    const neither = await (await openProject(root)).run('bails')
    expect(neither.summary.results).toHaveLength(2)
  })

  it('runs with the feature flags given', async () => {
    const root = await project({
      'environments/local.yml': [
        'name: local',
        'vars:',
        `  baseUrl: ${server.origin}`,
        'flags:',
        '  values: { newCheckout: false }',
        ''
      ].join('\n'),
      'collections/flagged.yml': collection('flagged', ['/ok'], 'flags: { newCheckout: true }')
    })
    const off = await (await openProject(root)).run('flagged')
    expect(off.summary.results[0]?.status).toBe('skipped')
    const on = await (await openProject(root, { flags: { newCheckout: true } })).run('flagged')
    expect(on.summary.results[0]?.status).toBe('pass')
  })
})

describe('use', () => {
  it('runs a request set with params, and gives back what it saved', async () => {
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok']),
      'requests/login.yml': LOGIN
    })
    const opened = await openProject(root)
    const outcome = await opened.use('login', { user: 'ann' })
    expect(outcome).toMatchObject({ passed: true, id: 'login', error: null })
    expect(outcome.file).toBe(path.join(opened.root, 'requests', 'login.yml'))
    expect(outcome.values).toEqual({ seen: '/ok/ann' })
    const [result] = outcome.summary.results
    expect(result?.use).toEqual({ set: 'login', child: 0, of: 1 })
    expect(result?.item.path).toBe(outcome.file)
    expect(outcome.steps).toEqual([{ file: outcome.file, line: 6, index: 0 }])
  })

  it('fails as the set’s checks do, and when a param it needs is missing', async () => {
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok']),
      'requests/login.yml': LOGIN
    })
    const opened = await openProject(root)
    const wrong = await opened.use('login', { user: 'ann', expect: 401 })
    expect(wrong.passed).toBe(false)
    expect(wrong.failures).toContain('Expected 401, got 200')

    const missing = await opened.use('login')
    expect(missing.passed).toBe(false)
    expect(missing.summary.results[0]?.error?.message).toMatch(/user/)
  })

  it('runs a set from the global project, with the project’s own environment', async () => {
    const root = await makeProject({
      'service/project.yml': 'uses: ../shared\n',
      'service/collections/smoke.yml': collection('smoke', ['/ok']),
      'service/environments/local.yml': `vars:\n  baseUrl: ${server.origin}\n`,
      'shared/project.yml': 'name: shared\n',
      'shared/requests/login.yml': LOGIN
    })
    roots.push(root)
    const opened = await openProject(path.join(root, 'service'), { environment: 'local' })
    const file = path.join(await fs.realpath(root), 'shared', 'requests', 'login.yml')
    for (const name of ['login', 'global:login']) {
      const outcome = await opened.use(name, { user: 'ann' })
      expect(outcome).toMatchObject({ passed: true, id: name, file })
      expect(outcome.values).toEqual({ seen: '/ok/ann' })
      expect(outcome.steps).toEqual([{ file, line: 6, index: 0 }])
    }
  })

  it('starts a set from the values given, and stops it at bail and timeoutCollection', async () => {
    const set = (id: string, paths: string[]) =>
      [
        `id: ${id}`,
        'params: {}',
        'steps:',
        ...paths.flatMap((p) => [
          `  - GET: '{{baseUrl}}${p}'`,
          '    tests: gta.expectResponseStatusCodeToBe(200)'
        ]),
        ''
      ].join('\n')
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok']),
      'requests/tenant.yml': set('tenant', ['/ok/{{tenant}}']),
      'requests/two.yml': set('two', ['/fail', '/ok']),
      'requests/slow.yml': set('slow', ['/slow'])
    })
    const opened = await openProject(root)

    const given = await opened.use('tenant', {}, { vars: { tenant: 't-9' } })
    expect(given.passed).toBe(true)
    expect(given.summary.results[0]?.request.url).toBe(`${server.origin}/ok/t-9`)

    const bailed = await opened.use('two', {}, { bail: true })
    expect(bailed.summary).toMatchObject({ total: 2, failed: 1, skipped: 1 })
    expect(bailed.summary.results).toHaveLength(1)
    expect((await opened.use('two')).summary.results).toHaveLength(2)

    const timed = await (await openProject(root, { timeoutCollection: 200 })).use('slow')
    expect(timed.passed).toBe(false)
    expect(timed.error).toBe('Timed out after 200 ms (timeoutCollection)')
  })

  it('rejects a set nothing answers to', async () => {
    const root = await project({ 'collections/smoke.yml': collection('smoke', ['/ok']) })
    await expect((await openProject(root)).use('nope')).rejects.toThrow(/use: nope/)
  })
})
