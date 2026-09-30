import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema, type Collection } from '../model/documents.js'
import { resultName, type RunResult } from '../model/run.js'
import { exportsOf } from '../runtime/sandbox.js'
import { listRequestSets, loadChecks, resolveRequestSet } from '../workspace/library.js'
import { VariableScope } from '../vars/scope.js'
import { referenceProblems, resolveParams } from './plan.js'
import { runCollection } from './runCollection.js'
import { runRequest } from './runRequest.js'

let tmp: string
let shop: string
let shared: string
let server: http.Server
let origin: string
let seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []

const write = async (file: string, body: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers })
    const status = req.url?.includes('/login/bad') ? 401 : 200
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ token: 'tok-1', url: req.url }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-reuse-')))
  shop = path.join(tmp, 'shop')
  shared = path.join(tmp, 'shared')

  await write(path.join(shop, 'project.yml'), 'uses: ../shared\n')
  await write(
    path.join(shop, 'requests', 'login.yml'),
    [
      'id: login',
      'params:',
      '  username: { required: true, description: who }',
      '  expectStatus: 200',
      'headers:',
      '  X-Set: login',
      'steps:',
      '  - name: log in',
      `    POST: "${origin}/login/{{params.username}}"`,
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(params.expectStatus)',
      "      if (params.expectStatus === 200) gta.set('token', res.body.token)",
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'orders', 'place.yml'),
    [
      'id: place',
      'params:',
      '  item: widget',
      'steps:',
      '  - name: add to cart',
      `    POST: "${origin}/cart/{{params.item}}"`,
      '  - name: check out',
      `    POST: "${origin}/checkout?token={{token}}"`,
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'account.yml'),
    [
      'id: account',
      'params:',
      "  id: '{{$uuid}}'",
      "  email: '{{params.id}}@example.com'",
      'steps:',
      '  - name: create',
      `    POST: "${origin}/account/{{params.id}}/{{params.id}}/{{params.email}}"`,
      '    tests: |',
      '      if (params.email !== `${params.id}@example.com`) throw new Error(params.email)',
      '  - name: read',
      `    GET: "${origin}/account/{{params.id}}"`,
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'loop.yml'),
    [
      'id: loop',
      'params:',
      "  a: '{{params.b}}'",
      "  b: '{{params.a}}'",
      'steps:',
      `  - GET: "${origin}/loop/{{params.a}}"`,
      `  - GET: "${origin}/loop/{{params.b}}"`,
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'typo.yml'),
    `id: typo\nparams:\n  who: '{{nobody}}'\nsteps:\n  - GET: "${origin}/typo/{{params.who}}"\n`
  )
  await write(
    path.join(shop, 'requests', 'user.yml'),
    [
      'id: user',
      'params:',
      '  saveTokenAs: { required: true }',
      'steps:',
      '  - name: token',
      `    POST: "${origin}/token"`,
      '    tests: |',
      '      gta.set(params.saveTokenAs, res.body.token)',
      '  - name: profile',
      `    GET: "${origin}/profile"`,
      '    headers:',
      "      Authorization: 'Bearer {{@params.saveTokenAs}}'",
      '    useTests: true',
      '  - name: wait',
      `    GET: "${origin}/wait"`,
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'not-a-set.yml'),
    `id: not-a-set\nsteps:\n  - GET: "${origin}/x"\n`
  )
  await write(path.join(shared, 'project.yml'), 'name: Shared\n')
  await write(
    path.join(shared, 'requests', 'ping.yml'),
    `id: ping\nparams: {}\nsteps:\n  - name: ping\n    GET: "${origin}/ping"\n`
  )
  await write(
    path.join(shared, 'checks', 'common.js'),
    [
      'export function ok() {',
      '  gta.expectResponseStatusCodeToBe(200)',
      '}',
      'export const answer = 42',
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'checks', 'orders.js'),
    'export async function placed(item) {\n  gta.expectResponseBodyToHaveProperty("url", `/cart/${item}`)\n}\n'
  )
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmp, { recursive: true, force: true })
})

const run = async (
  steps: unknown[],
  extra: Partial<Collection> = {},
  flags: Record<string, boolean> | null = null
) => {
  seen = []
  const collectionPath = path.join(shop, 'collections', 'suite.yml')
  const collection = CollectionSchema.parse({ id: 'suite', ...extra, steps })
  const reported: Array<[number, RunResult]> = []
  const summary = await runCollection({
    collection,
    collectionPath,
    context: { collectionPath, env: {}, ...(flags ? { flags } : {}) },
    onResult: (index, result) => reported.push([index, result])
  })
  return { summary, reported }
}

describe('finding what a project can reuse', () => {
  it('lists its request sets, one directory deep, then its global project’s', async () => {
    const sets = await listRequestSets(shop, { root: shared })
    expect(sets.map((set) => `${set.source}:${set.name}`)).toEqual([
      'project:account',
      'project:login',
      'project:loop',
      'project:not-a-set',
      'project:orders/place',
      'project:typo',
      'project:user',
      'global:ping'
    ])
  })

  it('resolves a name in the project first, and global: only in the global project', async () => {
    expect((await resolveRequestSet(shop, { root: shared }, 'ping')).source).toBe('global')
    expect((await resolveRequestSet(shop, { root: shared }, 'global:ping')).source).toBe('global')
    await expect(resolveRequestSet(shop, { root: shared }, 'global:login')).rejects.toThrow(
      'no login.yml in the global project'
    )
    await expect(resolveRequestSet(shop, null, 'not-a-set')).rejects.toThrow(
      'has no params, so it is not a request set'
    )
    await expect(resolveRequestSet(shop, null, '../x')).rejects.toThrow(
      'not a name of a file in requests/'
    )
  })

  it('loads check files, the project’s over the global’s', async () => {
    const checks = await loadChecks(shop, { root: shared })
    expect(checks.map((check) => `${check.name}:${check.filename}`)).toEqual([
      'common:../shared/checks/common.js',
      'orders:checks/orders.js'
    ])
  })

  it('rewrites exports in place, keeping every line where it was', () => {
    const code = 'export function a() {}\n  export async function b() {}\nexport const c = 1\n'
    const rewritten = exportsOf(code)
    expect(rewritten.split('\n')).toHaveLength(code.split('\n').length)
    expect(rewritten).toBe(
      '__exports.a = a; function a() {}\n  __exports.b = b; async function b() {}\nconst c = __exports.c = 1\n'
    )
  })
})

describe('running a use step', () => {
  it('runs the set’s steps with params, the set’s headers, and its checks', async () => {
    const { summary, reported } = await run([
      { use: 'login', with: { username: 'alice' } },
      { name: 'after', GET: `${origin}/after?token={{token}}` }
    ])
    expect(seen.map((request) => request.url)).toEqual(['/login/alice', '/after?token=tok-1'])
    expect(seen[0]?.headers['x-set']).toBe('login')
    expect(summary).toMatchObject({ total: 2, passed: 2 })
    expect(reported.map(([index, result]) => [index, result.use])).toEqual([
      [0, { set: 'login', child: 0, of: 1 }],
      [1, undefined]
    ])
  })

  it('passes a param that changes what the checks expect', async () => {
    const { summary } = await run([{ use: 'login', with: { username: 'bad', expectStatus: 401 } }])
    expect(summary.passed).toBe(1)
  })

  it('resolves variables in with: when the set starts', async () => {
    const { summary } = await run(
      [
        { use: 'login', with: { username: 'alice' } },
        { use: 'orders/place', with: { item: '{{token}}' } }
      ],
      {}
    )
    expect(seen.map((request) => request.url)).toEqual([
      '/login/alice',
      '/cart/tok-1',
      '/checkout?token=tok-1'
    ])
    expect(summary.total).toBe(3)
  })

  it('runs the use step’s own tests after the set’s last step, with checks from files', async () => {
    const { reported } = await run([
      { use: 'login', with: { username: 'alice' } },
      {
        use: 'orders/place',
        tests: 'checks.common.ok()\nif (checks.common.answer !== 42) throw new Error("no const")'
      }
    ])
    const [, first, last] = reported.map(([, result]) => result)
    expect(first?.assertions).toHaveLength(0)
    expect(last?.assertions.map((a) => a.status)).toEqual(['pass'])
    expect(last?.status).toBe('pass')
  })

  it('reports a set’s failing check file on its own line', async () => {
    const { reported } = await run([
      {
        name: 'uses a check',
        GET: `${origin}/cart/widget`,
        tests: 'await checks.orders.placed("gadget")'
      }
    ])
    expect(reported[0]?.[1].status).toBe('fail')
  })

  it('refuses a missing param, an unknown one, and an unknown set — before sending', async () => {
    const { reported, summary } = await run([
      { use: 'login' },
      { use: 'login', with: { username: 'a', usernme: 'b' } },
      { use: 'nope' }
    ])
    expect(seen).toEqual([])
    expect(summary.errored).toBe(3)
    expect(reported.map(([, result]) => result.error?.message)).toEqual([
      'use: login — needs username in with:',
      'use: login — it takes no usernme (it takes: username, expectStatus)',
      'use: nope — there is no nope.yml in requests/'
    ])
  })

  it('refuses a use step with a request of its own, and a set that uses another', () => {
    expect(() => CollectionSchema.parse({ steps: [{ use: 'login', GET: 'http://x' }] })).toThrow(
      /cannot have GET/
    )
    expect(() => CollectionSchema.parse({ params: {}, steps: [{ use: 'login' }] })).toThrow(
      /cannot use another/
    )
  })

  it('runs a set on its own with its params’ defaults', async () => {
    seen = []
    const file = path.join(shop, 'requests', 'orders', 'place.yml')
    const collection = CollectionSchema.parse({
      id: 'place',
      params: { item: 'widget' },
      steps: [{ name: 'add', POST: `${origin}/cart/{{params.item}}` }]
    })
    const summary = await runCollection({
      collection,
      collectionPath: file,
      context: { collectionPath: file, env: {} }
    })
    expect(seen.map((request) => request.url)).toEqual(['/cart/widget'])
    expect(summary.results[0]?.use).toBeUndefined()
  })
})

describe('a set’s params', () => {
  it('resolves defaults when the set starts, each once, so scripts see what requests send', async () => {
    const { summary } = await run([{ use: 'account' }])
    const [create, read] = seen.map((request) => request.url.split('/').slice(2))
    const id = create?.[0]
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(create).toEqual([id, id, `${id}@example.com`])
    expect(read).toEqual([id])
    expect(summary).toMatchObject({ total: 2, passed: 2 })
  })

  it('resolves them for a step of a set run on its own', async () => {
    seen = []
    const file = path.join(shop, 'requests', 'account.yml')
    const collection = CollectionSchema.parse({
      id: 'account',
      params: { id: '{{$uuid}}', email: '{{params.id}}@example.com' },
      steps: [
        {
          POST: `${origin}/account/{{params.id}}/{{params.email}}`,
          tests: 'if (params.email !== `${params.id}@example.com`) throw new Error(params.email)'
        }
      ]
    })
    const result = await runRequest({
      step: collection.steps[0]!,
      collection,
      context: { collectionPath: file, env: {} }
    })
    expect(result.status).toBe('pass')
    const [id, email] = seen[0]!.url.split('/').slice(2)
    expect(email).toBe(`${id}@example.com`)
  })

  it('stops every step of a use whose params cannot resolve, before sending', async () => {
    const { summary, reported } = await run([
      { use: 'loop', name: 'go round' },
      { use: 'typo' },
      { name: 'after', GET: `${origin}/after` }
    ])
    expect(seen.map((request) => request.url)).toEqual(['/after'])
    expect(summary).toMatchObject({ total: 4, errored: 3, passed: 1 })
    const loop = 'use: loop — params.a refers to itself: params.a -> params.b -> params.a'
    expect(reported.map(([index, result]) => [index, result.error?.message, result.use])).toEqual([
      [0, loop, { set: 'loop', name: 'go round', child: 0, of: 2 }],
      [0, loop, { set: 'loop', name: 'go round', child: 1, of: 2 }],
      [
        1,
        `use: typo — params.who's default: Variable "nobody" is not defined in this environment.`,
        { set: 'typo', child: 0, of: 1 }
      ],
      [2, undefined, undefined]
    ])
  })

  it('resolves a default after the params it names, wherever they are declared', () => {
    const params = resolveParams(
      { email: '{{params.id}}@example.com', id: '{{$uuid}}' },
      {},
      new VariableScope()
    )
    expect(params.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(params.email).toBe(`${params.id}@example.com`)
  })

  it('keeps the type of a default that is only another param', () => {
    const params = resolveParams(
      { copy: '{{params.count}}', count: 2, on: true, flag: '{{params.on}}' },
      {},
      new VariableScope()
    )
    expect(params).toEqual({ copy: 2, count: 2, on: true, flag: true })
  })

  it('stops every step of a set run on its own whose defaults cannot resolve', async () => {
    seen = []
    const file = path.join(shop, 'requests', 'typo.yml')
    const collection = CollectionSchema.parse({
      id: 'typo',
      params: { who: '{{nobody}}' },
      steps: [{ GET: `${origin}/typo/1` }, { GET: `${origin}/typo/2` }]
    })
    const summary = await runCollection({
      collection,
      collectionPath: file,
      context: { collectionPath: file, env: {} }
    })
    expect(seen).toEqual([])
    const message = `use: typo — params.who's default: Variable "nobody" is not defined in this environment.`
    expect(summary.results.map((result) => [result.status, result.error?.message])).toEqual([
      ['error', message],
      ['error', message]
    ])
  })

  it('stops the run at a use whose params cannot resolve, when told to bail', async () => {
    seen = []
    const collectionPath = path.join(shop, 'collections', 'suite.yml')
    const collection = CollectionSchema.parse({
      id: 'suite',
      steps: [{ use: 'loop' }, { name: 'after', GET: `${origin}/after` }]
    })
    const summary = await runCollection({
      collection,
      collectionPath,
      context: { collectionPath, env: {} },
      bail: true
    })
    expect(seen).toEqual([])
    expect(summary).toMatchObject({ total: 3, errored: 1, skipped: 2 })
  })

  it('skips a use its flags rule out, whatever its params', async () => {
    const { summary } = await run([{ use: 'loop', flags: { beta: true } }], {}, { beta: false })
    expect(summary.results.map((result) => result.status)).toEqual(['skipped', 'skipped'])
  })
})

describe('a set that saves under the caller’s name, and checks a step of its choosing', () => {
  it('reads back what it saved with {{@params.x}}, and runs the use step’s tests on the marked step', async () => {
    const { summary, reported } = await run([
      {
        use: 'user',
        name: 'user 1',
        with: { saveTokenAs: 'accessToken1' },
        tests: "gta.expectResponseBodyToHaveProperty('url', '/profile')"
      },
      { name: 'after', GET: `${origin}/after/{{accessToken1}}` }
    ])
    expect(seen.map((request) => request.url)).toEqual([
      '/token',
      '/profile',
      '/wait',
      '/after/tok-1'
    ])
    expect(seen[1]?.headers.authorization).toBe('Bearer tok-1')
    expect(reported.map(([, result]) => [result.item.name, result.assertions.length])).toEqual([
      ['token', 0],
      ['profile', 1],
      ['wait', 0],
      ['after', 0]
    ])
    expect(summary).toMatchObject({ total: 4, passed: 4 })
  })

  it('refuses useTests outside a request set, and on two steps of one', () => {
    expect(() => CollectionSchema.parse({ steps: [{ GET: 'http://x', useTests: true }] })).toThrow(
      /useTests marks the request set step .* not a request set/
    )
    expect(() =>
      CollectionSchema.parse({
        params: {},
        steps: [
          { GET: 'http://x/1', useTests: true },
          { GET: 'http://x/2', useTests: true }
        ]
      })
    ).toThrow('only one step can have useTests; step 1 has it already')
  })
})

describe('naming a set’s requests', () => {
  it('names them by the use step that ran them, then the set’s step when it has several', async () => {
    const { reported } = await run([
      { use: 'login', name: 'sign in', with: { username: 'alice' } },
      { use: 'orders/place', name: 'buy a widget' },
      { use: 'login', with: { username: 'bob' } }
    ])
    expect(reported.map(([, result]) => resultName(result))).toEqual([
      'sign in',
      'buy a widget › add to cart',
      'buy a widget › check out',
      'log in'
    ])
    expect(reported[1]?.[1].use).toEqual({
      set: 'orders/place',
      name: 'buy a widget',
      child: 0,
      of: 2
    })
  })
})

describe('checking references without a run', () => {
  it('finds each extends: and use: a run would stop at, sending nothing', async () => {
    seen = []
    const collection = CollectionSchema.parse({
      id: 'suite',
      extends: 'nope',
      steps: [
        { use: 'login', with: { username: 'a' } },
        { use: 'login', with: { usernme: 'a' } },
        { use: 'nope' },
        { GET: `${origin}/x` }
      ]
    })
    const problems = await referenceProblems(
      collection,
      path.join(shop, 'collections', 'suite.yml')
    )
    expect(problems).toEqual([
      { step: null, message: 'extends: nope — there is no nope.yml in bases/' },
      { step: 1, message: 'use: login — it takes no usernme (it takes: username, expectStatus)' },
      { step: 2, message: 'use: nope — there is no nope.yml in requests/' }
    ])
    expect(seen).toEqual([])
  })
})
