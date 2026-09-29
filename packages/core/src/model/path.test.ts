import { describe, expect, it } from 'vitest'
import { xmlToObject } from './bodyObject.js'
import { stepsForTags } from './documents.js'
import { toJsonLines } from './jsonLines.js'
import { formatPath, parsePath, pathMatches, resolvePath, sortArraysBy } from './path.js'

describe('parsePath', () => {
  it('reads dot, bracket and each segments', () => {
    expect(parsePath('a.b[2].c')).toEqual([
      { kind: 'key', key: 'a' },
      { kind: 'key', key: 'b' },
      { kind: 'index', index: 2 },
      { kind: 'key', key: 'c' }
    ])
    expect(parsePath('sessions[].id')).toEqual([
      { kind: 'key', key: 'sessions' },
      { kind: 'each' },
      { kind: 'key', key: 'id' }
    ])
    expect(parsePath('[0].id')[0]).toEqual({ kind: 'index', index: 0 })
  })

  it('formats back to the canonical bracket spelling', () => {
    expect(formatPath(parsePath('groups[1].name'))).toBe('groups[1].name')
    expect(formatPath(parsePath('sessions[].id'))).toBe('sessions[].id')
  })
})

describe('resolvePath', () => {
  const body = { groups: [{ name: 'a' }, { name: 'b' }], empty: null }

  it('treats a numeric dot segment as an index', () => {
    expect(resolvePath(body, parsePath('groups.1.name'))).toEqual([
      { path: parsePath('groups[1].name'), value: 'b' }
    ])
  })

  it('fans out across [] and reports each concrete path', () => {
    expect(resolvePath(body, parsePath('groups[].name')).map((l) => l.value)).toEqual(['a', 'b'])
  })

  it('distinguishes absent from null', () => {
    expect(resolvePath(body, parsePath('missing'))).toEqual([])
    expect(resolvePath(body, parsePath('empty'))).toEqual([
      { path: parsePath('empty'), value: null }
    ])
  })
})

describe('pathMatches', () => {
  it('matches a dot index against a bracket index, and [] against any index', () => {
    expect(pathMatches(parsePath('groups.0.name'), parsePath('groups[0].name'))).toBe(true)
    expect(pathMatches(parsePath('groups[].name'), parsePath('groups[3].name'))).toBe(true)
    expect(pathMatches(parsePath('groups[1]'), parsePath('groups[0]'))).toBe(false)
  })

  it('claims descendants only with prefix', () => {
    expect(pathMatches(parsePath('roles'), parsePath('roles[0]'))).toBe(false)
    expect(pathMatches(parsePath('roles'), parsePath('roles[0]'), { prefix: true })).toBe(true)
  })
})

describe('sortArraysBy', () => {
  it('sorts arrays of objects by the first property, then the next', () => {
    const sorted = sortArraysBy(
      {
        list: [
          { id: 2, name: 'b' },
          { id: 1, name: 'z' },
          { id: 1, name: 'a' }
        ],
        tags: ['z', 'a']
      },
      ['id', 'name']
    )
    expect(sorted).toEqual({
      list: [
        { id: 1, name: 'a' },
        { id: 1, name: 'z' },
        { id: 2, name: 'b' }
      ],
      // Arrays without the property keep their order.
      tags: ['z', 'a']
    })
  })
})

describe('toJsonLines', () => {
  it('prints exactly what JSON.stringify(value, null, 2) prints', () => {
    const value = { a: 1, b: [true, null, { c: 'x' }], d: {}, e: [], f: { g: 'h' } }
    expect(
      toJsonLines(value)
        .map((line) => line.text)
        .join('\n')
    ).toBe(JSON.stringify(value, null, 2))
  })

  it('tags each line with the path it shows', () => {
    const lines = toJsonLines({ user: { roles: ['admin'] } })
    const line = lines.find((l) => l.text.includes('"admin"'))!
    expect(formatPath(line.path)).toBe('user.roles[0]')
    // Opening and closing lines of a container carry the container's path.
    expect(lines.filter((l) => formatPath(l.path) === 'user.roles')).toHaveLength(2)
  })
})

describe('xmlToObject', () => {
  it('converts the way xtest did: no namespaces, no attributes, arrays only when repeated', () => {
    const xml = [
      '<?xml version="1.0"?>',
      '<ns8:Accounts xmlns:ns8="urn:x" count="2">',
      '  <!-- comment -->',
      '  <ns8:account id="a"><name>One &amp; only</name><open>true</open><empty/></ns8:account>',
      '  <ns8:account><name><![CDATA[<Two>]]></name></ns8:account>',
      '  <single><id>7</id></single>',
      '</ns8:Accounts>'
    ].join('\n')
    expect(xmlToObject(xml)).toEqual({
      Accounts: {
        account: [{ name: 'One & only', open: 'true', empty: '' }, { name: '<Two>' }],
        single: { id: '7' }
      }
    })
  })

  it('rejects mismatched tags', () => {
    expect(() => xmlToObject('<a><b></a>')).toThrow(/Expected <\/b>/)
  })
})

describe('stepsForTags', () => {
  const steps = [
    { GET: 'http://x/a', tags: ['smoke'] },
    { GET: 'http://x/b', tags: ['auth'] },
    { GET: 'http://x/c' }
  ]

  it('runs everything when nothing is selected', () => {
    expect(stepsForTags({ steps }, [])).toEqual([0, 1, 2])
  })

  it('runs the whole collection when its own tags match', () => {
    expect(stepsForTags({ tags: ['api'], steps, stepTags: true }, ['api'])).toEqual([0, 1, 2])
    // A collection tag wins over step tags: it means "all of this".
    expect(stepsForTags({ tags: ['smoke'], steps, stepTags: true }, ['smoke'])).toEqual([0, 1, 2])
  })

  it('runs matching steps only when the collection allows step tags', () => {
    expect(stepsForTags({ steps, stepTags: true }, ['smoke', 'auth'])).toEqual([0, 1])
    expect(stepsForTags({ steps }, ['smoke'])).toEqual([])
  })

  it('leaves out a collection whose own tags are left out, whatever else it has', () => {
    expect(stepsForTags({ tags: ['api', 'slow'], steps }, ['api'], ['slow'])).toEqual([])
    expect(stepsForTags({ tags: ['slow'], steps }, [], ['slow'])).toEqual([])
    expect(stepsForTags({ tags: ['api'], steps }, [], ['slow'])).toEqual([0, 1, 2])
  })

  it('drops the steps left out, only where steps carry their own tags', () => {
    expect(stepsForTags({ steps, stepTags: true }, ['smoke'], ['auth'])).toEqual([0])
    expect(stepsForTags({ steps, stepTags: true }, [], ['smoke'])).toEqual([1, 2])
    // Without step tags a collection runs whole: its steps' tags cannot exist to match.
    expect(stepsForTags({ tags: ['api'], steps }, ['api'], ['auth'])).toEqual([0, 1, 2])
  })
})
