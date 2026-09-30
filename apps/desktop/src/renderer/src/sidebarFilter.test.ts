import { describe, expect, it } from 'vitest'
import type { CollectionSummary } from '@schwabyio/gravity-core/model'
import { filterCollections, keepsFile, matches } from './sidebarFilter.js'

const collection = (
  name: string,
  directory: string | null,
  tags: string[] = []
): CollectionSummary => ({
  path: `/p/collections/${directory ? `${directory}/` : ''}${name}.yml`,
  relativePath: `${directory ? `${directory}/` : ''}${name}.yml`,
  directory,
  name,
  stepCount: 1,
  tags,
  environmentsPath: null,
  problems: []
})

const all = [
  collection('sessions', 'checkout', ['smoke']),
  collection('refunds', 'checkout'),
  collection('login', null, ['auth']),
  collection('profile', 'users')
]

describe('the sidebar filter', () => {
  it('finds every word typed, in any case, across a collection’s name, directory and tags', () => {
    expect(matches('checkout SESS', 'sessions', 'checkout')).toBe(true)
    expect(matches('checkout sess', 'refunds', 'checkout')).toBe(false)
    expect(matches('', 'anything')).toBe(true)
    expect(matches('  ', 'anything')).toBe(true)
  })

  it('keeps the collections that match, the directories holding them, and an empty one by its name', () => {
    expect(filterCollections(all, ['checkout', 'users', 'empty'], 'smoke')).toEqual({
      collections: [all[0]],
      directories: ['checkout']
    })
    expect(filterCollections(all, ['checkout', 'users', 'empty'], 'checkout').collections).toEqual([
      all[0],
      all[1]
    ])
    expect(filterCollections(all, ['checkout', 'users', 'empty'], 'empt')).toEqual({
      collections: [],
      directories: ['empty']
    })
    expect(filterCollections(all, ['checkout'], '')).toEqual({
      collections: all,
      directories: ['checkout']
    })
  })

  it('keeps a request set, endpoints file or base by its name', () => {
    expect(keepsFile('log', { name: 'auth/login', title: 'login' })).toBe(true)
    expect(keepsFile('auth', { name: 'auth/login', title: 'login' })).toBe(true)
    expect(keepsFile('refund', { name: 'auth/login', title: 'login' })).toBe(false)
  })
})
