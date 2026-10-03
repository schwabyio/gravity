import { describe, expect, it } from 'vitest'
import type { CollectionSummary } from '@schwabyio/gravity-core/model'
import type { GitStatusView } from '@shared/ipc.js'
import { fromProject, gitMarks } from './gitMarks.js'

const project = (projectFiles: GitStatusView['projectFiles']) => ({
  path: '/repo/services/shop',
  git: { projectFiles } as GitStatusView
})

const collection = (path: string, data: string | null = null) =>
  ({
    path,
    dataFile: data ? { relativePath: data, rows: 1 } : null
  }) as CollectionSummary

describe('gitMarks', () => {
  const marks = gitMarks(
    project({
      'collections/orders.yml': 'modified',
      'collections/checkout/sessions.csv': 'modified',
      'collections/checkout/cart.yml': 'untracked',
      'collections/legacy/old.yml': 'deleted',
      'collections/auth/login.yml': 'conflicted',
      'collections/auth/token.yml': 'untracked',
      'requests/login.yml': 'added'
    })
  )

  it('marks a changed file M, a new one U and one in conflict C', () => {
    expect(marks.file('/repo/services/shop/collections/orders.yml')).toBe('modified')
    expect(marks.file('/repo/services/shop/requests/login.yml')).toBe('new')
    expect(marks.file('/repo/services/shop/collections/auth/login.yml')).toBe('conflicted')
    expect(marks.file('/repo/services/shop/collections/clean.yml')).toBeNull()
  })

  it('marks a collection whose data file changed', () => {
    expect(
      marks.collection(
        collection('/repo/services/shop/collections/checkout/sessions.yml', 'checkout/sessions.csv')
      )
    ).toBe('modified')
  })

  it('marks a folder by the most pressing change inside it, a file gone from it included', () => {
    expect(marks.folder('auth')).toBe('conflicted')
    expect(marks.folder('checkout')).toBe('modified')
    expect(marks.folder('legacy')).toBe('modified')
    expect(marks.folder('clean')).toBeNull()
  })

  it('marks nothing without git', () => {
    const none = gitMarks({ path: '/repo/services/shop', git: null })
    expect(none.file('/repo/services/shop/collections/orders.yml')).toBeNull()
    expect(none.folder('auth')).toBeNull()
  })
})

describe('fromProject', () => {
  it('gives a path from the project folder with /, on any platform', () => {
    expect(fromProject('/repo/shop', '/repo/shop/collections/a.yml')).toBe('collections/a.yml')
    expect(fromProject('C:\\repo\\shop', 'C:\\repo\\shop\\collections\\a.yml')).toBe(
      'collections/a.yml'
    )
    expect(fromProject('/repo/shop', '/repo/shopping/collections/a.yml')).toBeNull()
  })
})
