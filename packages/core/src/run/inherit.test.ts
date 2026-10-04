import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CollectionSchema, type Collection } from '../model/documents.js'
import { findEndpoint, pathOf, placeholdersOf } from '../model/endpoints.js'
import type { RunResult } from '../model/run.js'
import { loadEndpoints } from '../workspace/library.js'
import { runCollection } from './runCollection.js'

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
    const id = /^\/users\/([^/?]+)/.exec(req.url ?? '')?.[1]
    if (id === '404') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"no such user"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(id === 'me' ? { me: true } : { id }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-inherit-')))
  shop = path.join(tmp, 'shop')
  shared = path.join(tmp, 'shared')
  await write(path.join(shop, 'project.yml'), 'uses: ../shared\n')
  await write(path.join(shared, 'project.yml'), 'name: Shared\n')
  await write(
    path.join(shop, 'endpoints', 'users.yml'),
    [
      'id: users',
      'headers:',
      '  X-Api: users',
      'tests: |',
      "  gta.expectResponseToHaveHeader('content-type', /json/)",
      'steps:',
      '  - GET: /users/{id}',
      '    headers:',
      '      Accept: application/json',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      "      gta.expectResponseBodyToHaveProperty('id', endpoint.id)",
      '  - GET: /users/me',
      '    tests: |',
      "      gta.expectResponseBodyToHaveProperty('me', true)",
      ''
    ].join('\n')
  )
  await write(
    path.join(shared, 'endpoints', 'common.yml'),
    [
      'id: common',
      'steps:',
      '  - GET: /users/{id}',
      '    headers: { X-From: global }',
      '  - GET: /health',
      '    headers: { X-From: global }',
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'bases', 'auth.yml'),
    [
      'id: auth',
      'headers:',
      '  Authorization: Bearer {{token}}',
      'vars:',
      '  token: t1',
      'before:',
      '  script: |',
      "    gta.set('fromBase', 'yes')",
      'tests: |',
      "  gta.test('base ran', () => assert.equal(gta.get('fromBase'), 'yes'))",
      ''
    ].join('\n')
  )
  await write(
    path.join(shop, 'requests', 'user.yml'),
    "id: user\nparams:\n  id: { required: true }\nsteps:\n  - GET: '{{baseUrl}}/users/{{params.id}}'\n"
  )
  await write(path.join(shop, 'bases', 'bad.yml'), `id: bad\nsteps:\n  - GET: "${origin}/x"\n`)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await fs.rm(tmp, { recursive: true, force: true })
})

const run = async (steps: unknown[], extra: Partial<Collection> = {}) => {
  seen = []
  const collectionPath = path.join(shop, 'collections', 'suite.yml')
  const collection = CollectionSchema.parse({
    id: 'suite',
    vars: { baseUrl: origin, userId: '42' },
    ...extra,
    steps
  })
  const results: RunResult[] = []
  await runCollection({
    collection,
    collectionPath,
    context: { collectionPath, collectionVars: collection.vars ?? null, env: {} },
    onResult: (_index, result) => results.push(result)
  })
  return results
}

describe('matching a request to an endpoint', () => {
  const endpoints = [
    { method: 'GET' as const, path: '/users/{id}' },
    { method: 'GET' as const, path: '/users/me' },
    { method: 'POST' as const, path: '/users' }
  ]

  it('reads the path, whatever stands for the host, ignoring the query', () => {
    expect(pathOf('{{baseUrl}}/users/{{id}}?x=1')).toEqual(['users', '{{id}}'])
    expect(pathOf('https://api.test:8443/users/7#top')).toEqual(['users', '7'])
    expect(pathOf('/users/')).toEqual(['users'])
  })

  it('matches a {name} with a value or a variable, the most specific winning', () => {
    expect(findEndpoint('GET', '{{baseUrl}}/users/{{id}}', endpoints)?.path).toBe('/users/{id}')
    expect(findEndpoint('GET', 'https://x/users/7', endpoints)?.path).toBe('/users/{id}')
    expect(findEndpoint('GET', '{{baseUrl}}/users/me', endpoints)?.path).toBe('/users/me')
    expect(findEndpoint('POST', '{{baseUrl}}/users?page=2', endpoints)?.path).toBe('/users')
    expect(findEndpoint('DELETE', '{{baseUrl}}/users/7', endpoints)).toBeNull()
    expect(findEndpoint('GET', '{{baseUrl}}/users/7/orders', endpoints)).toBeNull()
    // A variable never stands for a literal: it might be anything.
    expect(findEndpoint('GET', '{{baseUrl}}/{{what}}/me', endpoints)).toBeNull()
  })

  it('names each {name}’s segment as the step wrote it', () => {
    expect(placeholdersOf('/users/{id}', '{{baseUrl}}/users/{{userId}}')).toEqual({
      id: '{{userId}}'
    })
  })

  it('takes the project’s endpoint over its global project’s of the same method and path', async () => {
    const all = await loadEndpoints(shop, { root: shared })
    expect(all.map((endpoint) => `${endpoint.source}:${endpoint.method} ${endpoint.path}`)).toEqual(
      ['project:GET /users/{id}', 'project:GET /users/me', 'global:GET /health']
    )
  })
})

describe('a request under its endpoint’s base', () => {
  it('gets the endpoint’s headers and checks, with endpoint.id resolved', async () => {
    const [result] = await run([{ name: 'get', GET: '{{baseUrl}}/users/{{userId}}' }])
    expect(seen[0]?.headers['x-api']).toBe('users')
    expect(seen[0]?.headers['accept']).toBe('application/json')
    expect(result?.status).toBe('pass')
    expect(
      result?.assertions.map((assertion) => `${assertion.target}:${assertion.path ?? ''}`)
    ).toEqual(['header:content-type', 'status:', 'body:id'])
    // Each says whose script made it: the endpoints file's own tests, then the endpoint's.
    expect(result?.assertions.map((assertion) => assertion.source)).toEqual([
      { script: 'endpoint-file', line: 1 },
      { script: 'endpoint', line: 1 },
      { script: 'endpoint', line: 2 }
    ])
  })

  it('lets a step’s own check replace the base’s check of the same thing', async () => {
    const [result] = await run([
      {
        name: 'missing user',
        GET: '{{baseUrl}}/users/404',
        tests: [
          'gta.expectResponseStatusCodeToBe(404)',
          "gta.expectResponseBodyToHaveProperty('error', 'no such user')",
          "gta.expectResponseBodyToHaveProperty('id', '', 'notThisExpectedKey')"
        ].join('\n')
      }
    ])
    expect(result?.error ?? null).toBeNull()
    expect(result?.status).toBe('pass')
    // The base's content-type check had nothing replacing it, so it stays.
    expect(result?.assertions.map((assertion) => assertion.target)).toEqual([
      'header',
      'status',
      'body',
      'body'
    ])
  })

  it('uses the most specific endpoint', async () => {
    const [result] = await run([{ GET: '{{baseUrl}}/users/me' }])
    expect(result?.assertions.map((assertion) => assertion.path ?? assertion.target)).toEqual([
      'content-type',
      'me'
    ])
  })

  it('uses none when the step says base: false', async () => {
    const [result] = await run([{ GET: '{{baseUrl}}/users/{{userId}}', base: false }])
    expect(seen[0]?.headers['x-api']).toBeUndefined()
    expect(result?.assertions).toEqual([])
  })

  it('uses the global project’s endpoint where the project has none', async () => {
    await run([{ GET: '{{baseUrl}}/health' }])
    expect(seen[0]?.headers['x-from']).toBe('global')
  })
})

describe('a request set’s step under the caller’s base and its endpoint’s', () => {
  it('reads with: after the base’s before.script, and checks endpoint.id as the set sent it', async () => {
    const [result] = await run([{ use: 'user', with: { id: '{{fromBase}}' } }], {
      extends: 'auth'
    })
    expect(seen.map((request) => request.url)).toEqual(['/users/yes'])
    expect(result?.status).toBe('pass')
    expect(
      result?.assertions.map((assertion) => `${assertion.target}:${assertion.path ?? ''}`)
    ).toEqual(['header:content-type', 'status:', 'body:id', 'custom:'])
  })
})

describe('a collection that extends a base', () => {
  it('gets the base’s headers, variables and scripts, under its own', async () => {
    const [result] = await run([{ GET: '{{baseUrl}}/health' }], { extends: 'auth' })
    expect(result?.error ?? null).toBeNull()
    expect(seen[0]?.headers['authorization']).toBe('Bearer t1')
    expect(result?.assertions.find((assertion) => assertion.name === 'base ran')?.status).toBe(
      'pass'
    )
  })

  it('lets the collection’s own variables win over the base’s', async () => {
    await run([{ GET: '{{baseUrl}}/health' }], {
      extends: 'auth',
      vars: { baseUrl: origin, token: 'mine' }
    })
    expect(seen[0]?.headers['authorization']).toBe('Bearer mine')
  })

  it('stops every step, before sending, when the base cannot be used', async () => {
    const results = await run([{ GET: '{{baseUrl}}/health' }], { extends: 'bad' })
    expect(seen).toEqual([])
    expect(results[0]?.error?.message).toBe(
      'extends: bad — a base collection has no steps of its own'
    )
    const missing = await run([{ GET: '{{baseUrl}}/health' }], { extends: 'nope' })
    expect(missing[0]?.error?.message).toBe('extends: nope — there is no nope.yml in bases/')
  })
})
