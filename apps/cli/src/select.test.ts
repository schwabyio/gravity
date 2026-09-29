import { describe, expect, it } from 'vitest'
import type { Collection, LoadedCollection } from '@schwabyio/gravity-core'
import { selectCollections } from './select.js'

const loaded = (relativePath: string, doc: Partial<Collection> = {}, broken = false) =>
  ({
    path: `/p/collections/${relativePath}`,
    relativePath,
    directory: relativePath.includes('/') ? relativePath.split('/')[0]! : null,
    name: relativePath
      .split('/')
      .pop()!
      .replace(/\.yml$/, ''),
    doc: { steps: [{ GET: '/a' }, { GET: '/b' }], ...doc },
    stepNames: [],
    environmentsPath: '/p/environments',
    dataFile: null,
    problems: broken ? [{ path: relativePath, message: 'will not parse' }] : []
  }) as LoadedCollection

const smoke = loaded('smoke.yml', { tags: ['smoke'] })
const sessions = loaded('checkout/sessions.yml')
const refunds = loaded('checkout/refunds.yml', {
  stepTags: true,
  steps: [{ GET: '/r1', tags: ['smoke'] }, { GET: '/r2' }, { GET: '/r3', tags: ['smoke'] }]
})
const all = [smoke, sessions, refunds]
const none = { tags: [] }
const ids = (selection: ReturnType<typeof selectCollections>) => selection.targets.map((t) => t.id)

describe('selectCollections', () => {
  it('runs everything for all', () => {
    expect(ids(selectCollections(all, { kind: 'all' }, none))).toEqual([
      'smoke',
      'sessions',
      'refunds'
    ])
  })

  it('runs a list in the order given, a directory expanding in place', () => {
    const selection = selectCollections(
      all,
      { kind: 'list', selectors: ['checkout/', 'smoke.yml', 'refunds'] },
      none
    )
    expect(ids(selection)).toEqual(['sessions', 'refunds', 'smoke'])
  })

  it('finds a directory with an accented name however either is encoded', () => {
    // macOS may keep `Café` decomposed; a terminal types it composed.
    const cafe = loaded('Cafe\u0301/menu.yml')
    const selection = selectCollections([...all, cafe], { kind: 'list', selectors: ['Café'] }, none)
    expect(ids(selection)).toEqual(['menu'])
  })

  it('reads Windows separators and a collections/ prefix', () => {
    const selection = selectCollections(
      all,
      { kind: 'list', selectors: ['collections\\checkout\\sessions.yml'] },
      none
    )
    expect(ids(selection)).toEqual(['sessions'])
  })

  it('takes a collection over a directory of the same name, unless given with /', () => {
    const checkout = loaded('checkout.yml')
    const withSame = [...all, checkout]
    expect(
      ids(selectCollections(withSame, { kind: 'list', selectors: ['checkout'] }, none))
    ).toEqual(['checkout'])
    expect(
      ids(selectCollections(withSame, { kind: 'list', selectors: ['checkout/'] }, none))
    ).toEqual(['sessions', 'refunds'])
  })

  it('refuses a name that matches nothing', () => {
    expect(() =>
      selectCollections(all, { kind: 'list', selectors: ['smoke', 'nope'] }, none)
    ).toThrow('No collection or directory is called "nope"')
  })

  it('leaves an excluded collection out of all and its directory, but runs it when named', () => {
    const legacy = loaded('checkout/legacy.yml', { exclude: true })
    const withLegacy = [...all, legacy]
    const everything = selectCollections(withLegacy, { kind: 'all' }, none)
    expect(ids(everything)).toEqual(['smoke', 'sessions', 'refunds'])
    expect(everything.excluded).toEqual(['legacy'])

    const directory = selectCollections(withLegacy, { kind: 'list', selectors: ['checkout'] }, none)
    expect(ids(directory)).toEqual(['sessions', 'refunds'])
    expect(directory.excluded).toEqual(['legacy'])

    const named = selectCollections(
      withLegacy,
      { kind: 'list', selectors: ['checkout', 'legacy'] },
      none
    )
    expect(ids(named)).toEqual(['sessions', 'refunds', 'legacy'])
    expect(named.excluded).toEqual([])
  })

  it('picks whole collections and tagged steps by tag', () => {
    const selection = selectCollections(all, { kind: 'all' }, { tags: ['smoke'] })
    expect(selection.targets.map((t) => [t.id, t.steps])).toEqual([
      ['smoke', null],
      ['refunds', [0, 2]]
    ])
    expect(selection.untagged).toBe(1)
  })

  it('keeps a broken collection, so it is reported rather than dropped', () => {
    const broken = loaded('broken.yml', {}, true)
    const selection = selectCollections([broken], { kind: 'all' }, { tags: ['x'] })
    expect(selection.targets).toMatchObject([{ id: 'broken', broken: 'will not parse' }])
  })
})
