import { describe, expect, it } from 'vitest'
import type { AssertionResult } from '@schwabyio/gravity-core/model'
import { tabFor } from './testLinks.js'

const assertion = (target: AssertionResult['target']) =>
  ({ target, name: 'x', status: 'pass' }) as AssertionResult

describe('tabFor', () => {
  it('opens the tab an assertion is about', () => {
    expect(tabFor(assertion('body'))).toBe('body')
    expect(tabFor(assertion('strict'))).toBe('body')
    expect(tabFor(assertion('header'))).toBe('headers')
    expect(tabFor(assertion('status'))).toBeNull()
    expect(tabFor(assertion('custom'))).toBeNull()
  })
})
