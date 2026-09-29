import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StepSchema } from '../model/documents.js'
import { runRequest } from '../run/runRequest.js'
import { buildScope, environmentLayer } from './resolve.js'
import { previewVariables, referencedVariables } from './preview.js'

let root: string
let collectionPath: string
let nestedPath: string

const write = async (relative: string, body: string) => {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, body)
}

const context = (
  file: string,
  environmentName: string | null,
  env: Record<string, string> = {}
) => ({
  collectionPath: file,
  environmentName,
  env
})

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-vars-')))

  collectionPath = path.join(root, 'collections', 'checkout.yml')
  await write(
    path.join('collections', 'checkout.yml'),
    [
      'id: checkout',
      'vars:',
      '  apiVersion: "2"',
      '  scope: collection',
      'steps:',
      '  - name: create',
      '    GET: "{{baseUrl}}/v{{apiVersion}}/sessions"',
      ''
    ].join('\n')
  )

  await write(
    'environments/demo.yml',
    [
      'name: demo',
      'vars:',
      '  baseUrl: https://demo.test',
      '  strictValidation: true',
      '  retries: 3',
      '  scope: environment',
      '  apiKey: { secret: true }',
      ''
    ].join('\n')
  )
  await write(
    'environments/prod.yml',
    ['name: production', 'vars:', '  baseUrl: https://prod.test', ''].join('\n')
  )
  await write('.env', 'apiKey=from-dot-env\n')

  // A nested collection with its own environments/ closer to it.
  nestedPath = path.join(root, 'services', 'auth', 'collections', 'login.yml')
  await write(
    path.join('services', 'auth', 'collections', 'login.yml'),
    'id: login\nsteps:\n  - GET: "{{baseUrl}}/login"\n'
  )
  await write(
    path.join('services', 'auth', 'environments', 'demo.yml'),
    'name: demo\nvars:\n  baseUrl: https://auth.test\n'
  )
})

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('buildScope', () => {
  it('layers collection under environment', async () => {
    const scope = await buildScope(context(collectionPath, 'demo', { apiKey: 'x' }))
    expect(scope.get('apiVersion')).toBe('2')
    expect(scope.get('baseUrl')).toBe('https://demo.test')
    expect(scope.get('scope')).toBe('environment')
  })

  it('keeps YAML types instead of stringifying them', async () => {
    const scope = await buildScope(context(collectionPath, 'demo', { apiKey: 'x' }))
    expect(scope.get('strictValidation')).toBe(true)
    expect(scope.get('retries')).toBe(3)
  })

  it('lets the process environment override a declared variable', async () => {
    const scope = await buildScope(
      context(collectionPath, 'demo', { apiKey: 'x', baseUrl: 'https://override.test' })
    )
    expect(scope.get('baseUrl')).toBe('https://override.test')
  })

  it('works with no environment selected', async () => {
    const scope = await buildScope(context(collectionPath, null))
    expect(scope.get('apiVersion')).toBe('2')
    expect(scope.has('baseUrl')).toBe(false)
  })

  it('uses the collection variables it is given instead of the saved ones', async () => {
    const scope = await buildScope({
      ...context(collectionPath, null),
      collectionVars: { apiVersion: '3', added: true }
    })
    expect(scope.get('apiVersion')).toBe('3')
    expect(scope.get('added')).toBe(true)
    expect(scope.has('retries')).toBe(false)
  })

  it('uses the environment it is given instead of the saved one, secrets still resolved', async () => {
    const scope = await buildScope({
      // Chosen by its edited name, before the rename is saved.
      ...context(collectionPath, 'renamed', { apiKey: 'x' }),
      environments: [
        {
          path: path.join(root, 'environments', 'demo.yml'),
          doc: {
            name: 'renamed',
            vars: { baseUrl: 'https://edited.test', apiKey: { secret: true } }
          }
        }
      ]
    })
    expect(scope.get('baseUrl')).toBe('https://edited.test')
    expect(scope.get('apiKey')).toBe('x')
    expect(scope.has('retries')).toBe(false)
  })

  it('gives each service project its own environments, not the repository root ones', async () => {
    const scope = await buildScope(context(nestedPath, 'demo'))
    expect(scope.get('baseUrl')).toBe('https://auth.test')
  })
})

describe('secrets', () => {
  it('reads a secret from the process environment', async () => {
    const layer = await environmentLayer(
      context(collectionPath, 'demo', { apiKey: 'from-process' }),
      'demo'
    )
    expect(layer.vars['apiKey']).toBe('from-process')
  })

  it('falls back to .env beside the environments directory', async () => {
    const layer = await environmentLayer(context(collectionPath, 'demo'), 'demo')
    expect(layer.vars['apiKey']).toBe('from-dot-env')
  })

  it('records which names were declared secret', async () => {
    const layer = await environmentLayer(context(collectionPath, 'demo', { apiKey: 'x' }), 'demo')
    expect(layer.secrets).toEqual(['apiKey'])
  })

  it('fails clearly when a secret has no value anywhere', async () => {
    const bare = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'api-secret-')))
    await fs.mkdir(path.join(bare, 'environments'), { recursive: true })
    await fs.mkdir(path.join(bare, 'collections'), { recursive: true })
    await fs.writeFile(path.join(bare, 'collections', 'c.yml'), 'steps: []\n')
    await fs.writeFile(
      path.join(bare, 'environments', 'demo.yml'),
      'name: demo\nvars:\n  token: { secret: true }\n'
    )
    await expect(
      environmentLayer({ collectionPath: path.join(bare, 'collections', 'c.yml'), env: {} }, 'demo')
    ).rejects.toThrow(/Secret "token" has no value/)
    await fs.rm(bare, { recursive: true, force: true })
  })
})

describe('environment lookup', () => {
  it('finds an environment by filename', async () => {
    const layer = await environmentLayer(context(collectionPath, 'demo', { apiKey: 'x' }), 'demo')
    expect(layer.vars['baseUrl']).toBe('https://demo.test')
  })

  it('finds an environment by its declared name when the filename differs', async () => {
    const layer = await environmentLayer(
      context(collectionPath, null, { apiKey: 'x' }),
      'production'
    )
    expect(layer.vars['baseUrl']).toBe('https://prod.test')
  })

  it('fails with a clear message for an unknown environment', async () => {
    await expect(environmentLayer(context(collectionPath, null), 'nope')).rejects.toThrow(
      /Environment "nope" was not found/
    )
  })
})

describe('runRequest with variables', () => {
  const step = (url: string) => StepSchema.parse({ name: 'r', GET: url })

  it('reports an unresolved variable as an interpolation failure, not a network one', async () => {
    const result = await runRequest({
      step: step('{{missing}}/x'),
      context: context(collectionPath, 'demo', { apiKey: 'x' })
    })
    expect(result.status).toBe('error')
    expect(result.error?.phase).toBe('interpolate')
    expect(result.error?.message).toMatch(/"missing" is not defined/)
    expect(result.response).toBeNull()
  })

  it('runs the collection before.script before the step’s', async () => {
    const result = await runRequest({
      step: StepSchema.parse({
        GET: '{{a}}{{b}}',
        before: { script: "gta.set('b', `-${gta.get('a').length}`)" }
      }),
      collection: { steps: [], before: { script: "gta.set('a', 'from-collection')" } },
      context: context(collectionPath, null)
    })
    // It fails at the network, not at interpolation: both variables resolved.
    expect(result.error?.phase).toBe('http')
    expect(result.request.url).toBe('from-collection-15')
  })
})

describe('previewVariables', () => {
  const step = (url: string, before?: Record<string, unknown>) =>
    StepSchema.parse({ name: 'r', GET: url, ...(before ? { before } : {}) })

  it('resolves what it can, with where each value came from', async () => {
    const previews = await previewVariables(
      step('{{baseUrl}}'),
      context(collectionPath, 'demo', { apiKey: 'x' })
    )
    expect(previews['baseUrl']).toEqual({
      value: 'https://demo.test',
      // Written with `/` on every platform (SPEC.md §1.2).
      origin: 'environments/demo.yml',
      kind: 'static'
    })
    expect(previews['apiVersion']?.origin).toBe('checkout.yml')
  })

  it('never reveals a secret value, but still reports it as resolved', async () => {
    const previews = await previewVariables(
      step('x'),
      context(collectionPath, 'demo', { apiKey: 'super-secret' })
    )
    expect(previews['apiKey']?.kind).toBe('secret')
    expect(previews['apiKey']?.value).toBeNull()
  })

  it('marks what a pre-request script sets as dynamic: known, but not yet valued', async () => {
    const previews = await previewVariables(
      step('x', { script: "gta.set('id', gta.uuid())\ngta.set(\"label\", 'run')" }),
      context(collectionPath, 'demo', { apiKey: 'x' })
    )
    expect(previews['id']).toEqual({ value: null, origin: 'pre-request script', kind: 'dynamic' })
    expect(previews['label']?.kind).toBe('dynamic')
  })

  it('uses the collection script it is given instead of the saved one', async () => {
    const previews = await previewVariables(
      step('x'),
      context(collectionPath, 'demo', { apiKey: 'x' }),
      "gta.set('edited', 1)"
    )
    expect(previews['edited']?.kind).toBe('dynamic')
  })

  it('always includes the built-ins', async () => {
    const previews = await previewVariables(step('x'), null)
    expect(previews['$uuid']).toEqual({ value: null, origin: 'built-in', kind: 'dynamic' })
  })

  it('omits an unknown variable so the editor can grey it out', async () => {
    const previews = await previewVariables(
      step('{{nope}}'),
      context(collectionPath, 'demo', { apiKey: 'x' })
    )
    expect(previews['nope']).toBeUndefined()
  })
})

describe('referencedVariables', () => {
  it('finds every reference in a step', () => {
    const step = StepSchema.parse({
      POST: '{{baseUrl}}/{{apiVersion}}',
      headers: { 'X-A': '{{realm}}', 'X-B': 'plain' },
      body: { json: '{"k": "{{token}}"}' }
    })
    expect(referencedVariables(step)).toEqual(['apiVersion', 'baseUrl', 'realm', 'token'])
  })
})
