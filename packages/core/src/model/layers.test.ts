import { describe, expect, it } from 'vitest'
import { foldLayers, requestLayers } from './layers.js'

describe('a request’s layers', () => {
  it('are the endpoints file’s, the endpoint’s, the base’s, the collection’s, the set’s and the step’s, in that order', () => {
    const layers = requestLayers({
      endpoint: {
        file: { headers: { 'X-Request-Id': '{{requestId}}' }, before: { script: 'a()' } },
        step: { headers: { Accept: 'application/json' }, tests: 'b()' }
      },
      base: { headers: { Authorization: 'Bearer t1' } },
      collection: { settings: { timeout: 10 } },
      set: { tests: 'c()' },
      step: { before: { script: 'd()' } }
    })
    expect(layers).toEqual([
      {
        kind: 'endpoint-file',
        headers: { 'X-Request-Id': '{{requestId}}' },
        settings: undefined,
        before: { script: 'a()' },
        tests: undefined
      },
      {
        kind: 'endpoint',
        headers: { Accept: 'application/json' },
        settings: undefined,
        before: undefined,
        tests: 'b()'
      },
      {
        kind: 'base',
        headers: { Authorization: 'Bearer t1' },
        settings: undefined,
        before: undefined,
        tests: undefined
      },
      {
        kind: 'collection',
        headers: undefined,
        settings: { timeout: 10 },
        before: undefined,
        tests: undefined
      },
      { kind: 'set', headers: undefined, settings: undefined, before: undefined, tests: 'c()' },
      { kind: 'step', before: { script: 'd()' }, tests: undefined }
    ])
  })

  it('leave out an endpoint base, a base collection and a set when there is none', () => {
    const kinds = requestLayers({ endpoint: null, base: null, collection: {}, step: {} }).map(
      (layer) => layer.kind
    )
    expect(kinds).toEqual(['collection', 'step'])
  })

  it('fold nearer over outer: a header by any case, a setting by name, one switched off replacing nothing', () => {
    const folded = foldLayers([
      { headers: { Accept: 'application/json', 'X-Id': '1' }, settings: { timeout: 1 } },
      { headers: { accept: 'text/plain' }, settings: { maxRedirects: 2 } },
      { headers: { 'x-id': { value: '2', enabled: false } }, settings: { timeout: 3 } }
    ])
    expect(folded).toEqual({
      headers: { accept: 'text/plain', 'X-Id': '1' },
      settings: { timeout: 3, maxRedirects: 2 }
    })
    expect(foldLayers([{}, {}])).toEqual({ headers: undefined, settings: {} })
  })
})
