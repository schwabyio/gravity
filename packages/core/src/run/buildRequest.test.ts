import { describe, expect, it } from 'vitest'
import { httpVersionOf, StepSchema, SETTINGS_DEFAULTS } from '../model/documents.js'
import { resolveSettings, toBody, toHeaderEntries, toSentRequest } from './buildRequest.js'

const step = (extra: Record<string, unknown>) =>
  StepSchema.parse({ name: 'test', GET: 'http://x/y', ...extra })

describe('toHeaderEntries', () => {
  it('reads a plain string value', () => {
    expect(toHeaderEntries({ Accept: 'application/json' })).toEqual([
      { name: 'Accept', value: 'application/json' }
    ])
  })

  it('expands an array into a repeated header', () => {
    expect(toHeaderEntries({ 'Set-Cookie': ['a=1', 'b=2'] })).toEqual([
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' }
    ])
  })

  it('keeps an object header unless it is explicitly disabled', () => {
    expect(toHeaderEntries({ A: { value: '1' }, B: { value: '2', enabled: true } })).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' }
    ])
    expect(toHeaderEntries({ C: { value: '3', enabled: false } })).toEqual([])
  })

  it('sends each value of a repeated header that is not switched off', () => {
    expect(
      toHeaderEntries({
        'X-Forwarded-For': [
          '10.0.0.1',
          { value: '10.0.0.2', enabled: false },
          { value: '10.0.0.3', description: 'proxy' }
        ]
      })
    ).toEqual([
      { name: 'X-Forwarded-For', value: '10.0.0.1' },
      { name: 'X-Forwarded-For', value: '10.0.0.3' }
    ])
  })

  it('reads a list whose values take the long form, and refuses a value that is neither', () => {
    expect(step({ headers: { A: ['1', { value: '2', enabled: false }] } }).headers).toEqual({
      A: ['1', { value: '2', enabled: false }]
    })
    expect(() => step({ headers: { A: ['1', 2] } })).toThrow()
    expect(() => step({ headers: { A: [{ value: '1', on: true }] } })).toThrow()
  })

  it('lets a step list with a value switched on replace the collection’s, and one all off replace nothing', () => {
    const collection = { steps: [], headers: { 'X-A': 'collection' } }
    const sent = (headers: Record<string, unknown>) =>
      toSentRequest(step({ headers }), collection).headers.filter(
        (h) => h.name.toLowerCase() === 'x-a'
      )
    expect(sent({ 'x-a': ['one', { value: 'two', enabled: false }] })).toEqual([
      { name: 'x-a', value: 'one' }
    ])
    expect(
      sent({
        'x-a': [
          { value: 'one', enabled: false },
          { value: 'two', enabled: false }
        ]
      })
    ).toEqual([{ name: 'X-A', value: 'collection' }])
  })

  it('handles no headers at all', () => {
    expect(toHeaderEntries(undefined)).toEqual([])
  })
})

describe('toBody', () => {
  it('returns nothing when there is no body', () => {
    expect(toBody(undefined)).toEqual({ text: null, contentType: undefined })
  })

  it('renders each text form with its implied content type', () => {
    expect(toBody({ json: '{"a":1}' })).toEqual({
      text: '{"a":1}',
      contentType: 'application/json'
    })
    expect(toBody({ xml: '<a/>' })).toEqual({ text: '<a/>', contentType: 'application/xml' })
    expect(toBody({ text: 'hi' })).toEqual({ text: 'hi', contentType: 'text/plain' })
  })

  it('encodes a form body', () => {
    expect(toBody({ form: { a: '1', b: 'two words' } })).toEqual({
      text: 'a=1&b=two+words',
      contentType: 'application/x-www-form-urlencoded'
    })
  })

  it('encodes a graphql body as json', () => {
    const built = toBody({ graphql: { query: '{ me { id } }', variables: { x: 1 } } })
    expect(built.contentType).toBe('application/json')
    expect(JSON.parse(built.text ?? '')).toEqual({ query: '{ me { id } }', variables: { x: 1 } })
  })
})

describe('resolveSettings', () => {
  it('falls back to the documented defaults', () => {
    expect(resolveSettings(undefined)).toEqual(SETTINGS_DEFAULTS)
  })

  it('lets the most specific layer win', () => {
    expect(resolveSettings({ timeout: 100 }, { timeout: 200 }, { followRedirects: false })).toEqual(
      { ...SETTINGS_DEFAULTS, timeout: 200, followRedirects: false }
    )
  })

  it('ignores keys a layer leaves undefined', () => {
    expect(resolveSettings({ timeout: 100 }, { timeout: undefined }).timeout).toBe(100)
  })

  it('reads httpVersion however it was written, and lets a step put it back to auto', () => {
    expect([undefined, 'auto', 1.1, '1.1', 2, '2'].map((v) => httpVersionOf(v as never))).toEqual([
      'auto',
      'auto',
      '1.1',
      '1.1',
      '2',
      '2'
    ])
    expect(resolveSettings({ httpVersion: 2 }, { httpVersion: 'auto' }).httpVersion).toBe('auto')
  })
})

describe('toSentRequest', () => {
  it('reads the method from the single method key', () => {
    expect(toSentRequest(StepSchema.parse({ POST: 'http://x' })).method).toBe('POST')
  })

  it('adds the Content-Type implied by the body', () => {
    const sent = toSentRequest(StepSchema.parse({ POST: 'http://x', body: { json: '{}' } }))
    expect(sent.headers).toContainEqual({ name: 'Content-Type', value: 'application/json' })
  })

  it('never overrides a Content-Type the step declares', () => {
    const sent = toSentRequest(
      StepSchema.parse({
        POST: 'http://x',
        headers: { 'content-type': 'application/vnd.custom+json' },
        body: { json: '{}' }
      })
    )
    expect(sent.headers.filter((h) => h.name.toLowerCase() === 'content-type')).toHaveLength(1)
  })

  it('leaves the authored URL untouched, query string included', () => {
    expect(toSentRequest(step({ GET: 'http://x/y?a=1&b=2' })).url).toBe('http://x/y?a=1&b=2')
  })

  it('merges the collection headers underneath the step\u2019s', () => {
    const sent = toSentRequest(step({ headers: { Accept: 'application/json' } }), {
      headers: { Accept: '*/*', 'X-Shared': 'yes' },
      steps: []
    })
    expect(sent.headers).toEqual([
      { name: 'Accept', value: 'application/json' },
      { name: 'X-Shared', value: 'yes' }
    ])
  })

  it('lets a step header replace the collection\u2019s whatever its case', () => {
    const sent = toSentRequest(step({ headers: { accept: 'text/plain' } }), {
      headers: { Accept: '*/*', 'X-Shared': 'yes' },
      steps: []
    })
    expect(sent.headers).toEqual([
      { name: 'accept', value: 'text/plain' },
      { name: 'X-Shared', value: 'yes' }
    ])
  })

  it('does not let a disabled step header hide the collection\u2019s', () => {
    const sent = toSentRequest(
      step({ headers: { Accept: { value: 'text/plain', enabled: false } } }),
      { headers: { Accept: '*/*' }, steps: [] }
    )
    expect(sent.headers).toEqual([{ name: 'Accept', value: '*/*' }])
  })

  it('uses the collection headers when the step declares none', () => {
    const sent = toSentRequest(step({}), { headers: { Accept: '*/*' }, steps: [] })
    expect(sent.headers).toEqual([{ name: 'Accept', value: '*/*' }])
  })
})
