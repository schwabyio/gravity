import { describe, expect, it } from 'vitest'
import type { EndpointView, LibraryFileView } from '@shared/ipc.js'
import {
  findBase,
  headerCount,
  inheritedLayers,
  inheritedSettings,
  replacedBy,
  sentHeaders
} from './inheritance.js'

const endpoint: EndpointView = {
  method: 'GET',
  path: '/users/{id}',
  filePath: '/shared/endpoints/people.yml',
  fileName: 'people',
  source: 'global',
  headers: ['X-Request-Id', 'Accept'],
  hasTests: true,
  hasBefore: true,
  file: { headers: { 'X-Request-Id': '{{requestId}}' }, before: { script: 'set()' } },
  step: { headers: { Accept: 'application/json' }, settings: { timeout: 7000 }, tests: 'check()' }
}

const base = (name: string, source: LibraryFileView['source']): LibraryFileView => ({
  name,
  path: `/${source}/bases/${name}.yml`,
  source,
  title: name,
  stepCount: 0,
  layer: { headers: { Authorization: `Bearer ${source}` }, settings: { maxRedirects: 3 } }
})
const bases = [base('auth', 'project'), base('auth', 'global'), base('admin', 'global')]

const layersFor = (useBase = true) =>
  inheritedLayers({
    method: 'GET',
    url: '{{baseUrl}}/users/{{userId}}',
    useBase,
    endpoints: [endpoint],
    bases,
    collection: {
      extends: 'auth',
      headers: { accept: 'application/xml', 'X-Client': 'gta' },
      settings: { timeout: 10 }
    }
  })

describe('what a step inherits', () => {
  it('finds a base as a run does: the project’s, else the global project’s, and global: only there', () => {
    expect(findBase(bases, 'auth')?.source).toBe('project')
    expect(findBase(bases, 'global:auth')?.source).toBe('global')
    expect(findBase(bases, 'admin')?.source).toBe('global')
    expect(findBase(bases, 'global:nope')).toBeNull()
    expect(findBase(bases, undefined)).toBeNull()
  })

  it('lists the endpoints file’s, the endpoint’s, the base’s and the collection’s layers, outermost first', () => {
    expect(
      layersFor().map(({ kind, title, name, shared, used }) => ({
        kind,
        title,
        name,
        shared,
        used
      }))
    ).toEqual([
      {
        kind: 'endpoint-file',
        title: 'endpoints file',
        name: 'people.yml',
        shared: true,
        used: true
      },
      { kind: 'endpoint', title: 'endpoint', name: 'GET /users/{id}', shared: true, used: true },
      { kind: 'base', title: 'base collection', name: 'auth', shared: false, used: true },
      { kind: 'collection', title: 'collection', name: null, shared: false, used: true }
    ])
    expect(layersFor()[2]?.headers).toEqual({ Authorization: 'Bearer project' })
  })

  it('counts what is sent, and says what replaces a header, by any case', () => {
    const layers = layersFor()
    const own = { 'x-client': 'mine' }
    expect(sentHeaders(layers, own)).toEqual({
      'X-Request-Id': '{{requestId}}',
      accept: 'application/xml',
      Authorization: 'Bearer project',
      'x-client': 'mine'
    })
    expect(headerCount(sentHeaders(layers, own))).toBe(4)
    expect(replacedBy(layers, 1, 'Accept', own)).toBe('the collection')
    expect(replacedBy(layers, 3, 'X-Client', own)).toBe('this step')
    expect(replacedBy(layers, 0, 'X-Request-Id', own)).toBeNull()
    // A header of the step's that is off replaces nothing.
    expect(replacedBy(layers, 3, 'X-Client', { 'X-Client': { value: 'x', enabled: false } })).toBe(
      null
    )
  })

  it('leaves the endpoint base out of what is sent when the step says base: false', () => {
    const layers = layersFor(false)
    expect(layers.filter((layer) => !layer.used).map((layer) => layer.kind)).toEqual([
      'endpoint-file',
      'endpoint'
    ])
    expect(Object.keys(sentHeaders(layers, undefined))).toEqual([
      'Authorization',
      'accept',
      'X-Client'
    ])
    expect(replacedBy(layers, 3, 'accept', undefined)).toBeNull()
  })

  it('takes each setting from the nearest layer that sets it', () => {
    expect(inheritedSettings(layersFor())).toEqual({
      timeout: { value: 10, from: 'collection' },
      maxRedirects: { value: 3, from: 'base collection' }
    })
    const alone = inheritedLayers({
      method: 'GET',
      url: '/users/1',
      useBase: true,
      endpoints: [endpoint],
      bases: [],
      collection: {}
    })
    expect(inheritedSettings(alone)).toEqual({ timeout: { value: 7000, from: 'endpoint' } })
    expect(inheritedSettings(layersFor(false)).timeout).toEqual({ value: 10, from: 'collection' })
  })
})
