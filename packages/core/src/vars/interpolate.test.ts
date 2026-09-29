import { describe, expect, it } from 'vitest'
import { interpolate, interpolateDeep, interpolateToString } from './interpolate.js'
import { InterpolationError, VariableScope } from './scope.js'

const scopeOf = (vars: Record<string, unknown>, env: Record<string, string> = {}) =>
  new VariableScope([{ source: 'test', vars: vars as never }], env)

describe('interpolate', () => {
  it('substitutes a reference inside a larger string', () => {
    expect(interpolate('{{host}}/users', scopeOf({ host: 'https://x.test' }))).toBe(
      'https://x.test/users'
    )
  })

  it('ignores whitespace inside the braces', () => {
    expect(interpolate('{{  host  }}/a', scopeOf({ host: 'h' }))).toBe('h/a')
  })

  it('keeps the type when the string is exactly one reference', () => {
    expect(interpolate('{{flag}}', scopeOf({ flag: true }))).toBe(true)
    expect(interpolate('{{count}}', scopeOf({ count: 3 }))).toBe(3)
    expect(interpolate('{{nothing}}', scopeOf({ nothing: null }))).toBeNull()
  })

  it('stringifies once a reference is part of a larger string', () => {
    expect(interpolate('flag={{flag}}', scopeOf({ flag: true }))).toBe('flag=true')
    expect(interpolate('n={{count}}', scopeOf({ count: 3 }))).toBe('n=3')
  })

  it('resolves a variable that refers to another variable', () => {
    expect(
      interpolate('{{url}}', scopeOf({ url: '{{host}}/v{{version}}', host: 'h', version: 2 }))
    ).toBe('h/v2')
  })

  it('substitutes every occurrence', () => {
    expect(interpolate('{{a}}-{{a}}-{{b}}', scopeOf({ a: '1', b: '2' }))).toBe('1-1-2')
  })

  it('renders null and empty values as empty text inside a string', () => {
    expect(interpolate('x={{nothing}}', scopeOf({ nothing: null }))).toBe('x=')
  })

  it('fails on an unknown variable rather than leaving it in the URL', () => {
    expect(() => interpolate('{{missing}}/a', scopeOf({ present: 1 }))).toThrow(InterpolationError)
    expect(() => interpolate('{{missing}}/a', scopeOf({}))).toThrow(/"missing" is not defined/)
  })

  it('suggests a close name when one exists', () => {
    expect(() => interpolate('{{basUrl}}', scopeOf({ baseUrl: 'x' }))).toThrow(
      /Did you mean baseUrl/
    )
  })

  it('names the variable on the error so a caller can point at it', () => {
    try {
      interpolate('{{nope}}', scopeOf({}))
      expect.unreachable()
    } catch (error) {
      expect((error as InterpolationError).variable).toBe('nope')
    }
  })

  it('detects a direct self-reference', () => {
    expect(() => interpolate('{{a}}', scopeOf({ a: 'x{{a}}' }))).toThrow(/refers to itself/)
  })

  it('detects an indirect loop', () => {
    expect(() => interpolate('{{a}}', scopeOf({ a: '{{b}}x', b: '{{a}}y' }))).toThrow(
      /refers to itself/
    )
  })

  it('leaves text with no references alone', () => {
    expect(interpolate('https://x.test/plain', scopeOf({}))).toBe('https://x.test/plain')
  })
})

describe('built-in variables', () => {
  it('generates a uuid per reference', () => {
    const scope = scopeOf({})
    const a = interpolate('{{$uuid}}', scope) as string
    const b = interpolate('{{$uuid}}', scope) as string
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(a).not.toBe(b)
  })

  it('provides timestamps', () => {
    expect(Number(interpolate('{{$timestamp}}', scopeOf({})))).toBeGreaterThan(1_700_000_000_000)
    expect(interpolate('{{$isoTimestamp}}', scopeOf({}))).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('lets a declared variable shadow nothing — built-ins win', () => {
    expect(interpolate('{{$uuid}}', scopeOf({ $uuid: 'fixed' }))).not.toBe('fixed')
  })
})

describe('interpolateToString', () => {
  it('always produces a string, including for typed values', () => {
    expect(interpolateToString('{{flag}}', scopeOf({ flag: true }))).toBe('true')
    expect(interpolateToString('{{nothing}}', scopeOf({ nothing: null }))).toBe('')
  })
})

describe('interpolateDeep', () => {
  it('walks objects and arrays', () => {
    const result = interpolateDeep(
      { url: '{{host}}/a', tags: ['{{env}}', 'fixed'], nested: { n: '{{count}}' }, flag: false },
      scopeOf({ host: 'h', env: 'demo', count: 7 })
    )
    expect(result).toEqual({
      url: 'h/a',
      tags: ['demo', 'fixed'],
      nested: { n: 7 },
      flag: false
    })
  })
})

describe('VariableScope', () => {
  it('applies layers lowest precedence first', () => {
    const scope = new VariableScope([
      { source: 'collection', vars: { a: 'collection', b: 'collection' } },
      { source: 'folder', vars: { b: 'folder', c: 'folder' } },
      { source: 'environment', vars: { c: 'environment' } }
    ])
    expect(scope.get('a')).toBe('collection')
    expect(scope.get('b')).toBe('folder')
    expect(scope.get('c')).toBe('environment')
    expect(scope.originOf('c')).toBe('environment')
  })

  it('lets the process environment override a declared variable', () => {
    const scope = new VariableScope([{ source: 'env-file', vars: { baseUrl: 'from-file' } }], {
      baseUrl: 'from-ci'
    })
    expect(scope.get('baseUrl')).toBe('from-ci')
    expect(scope.originOf('baseUrl')).toBe('process environment')
  })

  it('never puts an undeclared ambient variable in scope', () => {
    // Otherwise PATH, HOME and everything else would be reachable from a URL.
    const scope = new VariableScope([{ source: 'env-file', vars: { baseUrl: 'x' } }], {
      PATH: '/usr/bin',
      SECRET_TOKEN: 'shh'
    })
    expect(scope.has('PATH')).toBe(false)
    expect(scope.has('SECRET_TOKEN')).toBe(false)
    expect(scope.names()).toEqual(['baseUrl'])
  })

  it('records values set during a run', () => {
    const scope = scopeOf({})
    scope.set('token', 'abc', 'before.set')
    expect(scope.get('token')).toBe('abc')
    expect(scope.originOf('token')).toBe('before.set')
  })
})
