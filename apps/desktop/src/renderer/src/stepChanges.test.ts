import { describe, expect, it } from 'vitest'
import type { Collection } from '@schwabyio/gravity-core/model'
import { changesSince } from './stepChanges.js'

const login = { name: 'login', POST: '/login' }
const list = { name: 'list', GET: '/orders' }
const create = { name: 'create', POST: '/orders' }
const remove = { name: 'remove', DELETE: '/orders/1' }

const doc = (steps: Collection['steps'], rest: Partial<Collection> = {}): Collection => ({
  id: 'orders',
  steps,
  ...rest
})

describe('changesSince', () => {
  it('marks nothing when nothing changed, key order aside', () => {
    const changes = changesSince(doc([login, list]), doc([{ POST: '/login', name: 'login' }, list]))
    expect(changes.steps.steps).toEqual([null, null])
    expect(changes.removed.steps).toBe(0)
    expect(changes.collection).toBe(false)
  })

  it('marks a step added, one changed by its name, and counts one removed', () => {
    const changes = changesSince(
      doc([login, list, remove]),
      doc([login, { ...list, GET: '/orders?page=2' }, create])
    )
    expect(changes.steps.steps).toEqual([null, 'changed', 'new'])
    expect(changes.removed.steps).toBe(1)
  })

  it('marks a step moved, and leaves the rest in order unmarked', () => {
    const changes = changesSince(doc([login, list, create]), doc([list, create, login]))
    expect(changes.steps.steps).toEqual([null, null, 'moved'])
    expect(changes.removed.steps).toBe(0)
  })

  it('looks at setup and teardown on their own, and at the rest of the collection', () => {
    const changes = changesSince(
      doc([list], { setup: [login] }),
      doc([list], { setup: [login], teardown: [remove], headers: { Accept: 'application/json' } })
    )
    expect(changes.steps.setup).toEqual([null])
    expect(changes.steps.teardown).toEqual(['new'])
    expect(changes.steps.steps).toEqual([null])
    expect(changes.collection).toBe(true)
  })
})
