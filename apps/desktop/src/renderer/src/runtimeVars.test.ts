import { describe, expect, it } from 'vitest'
import type { RuntimeVariable } from '@shared/ipc.js'
import { filterVariables, runtimeSummary, setByLabel } from './runtimeVars.js'

const token: RuntimeVariable = { name: 'authToken', value: 'eyJ', step: 'login', by: 'captured' }
const grant: RuntimeVariable = {
  name: 'grantId',
  value: '7',
  step: 'setup › grant',
  by: 'tests',
  row: 'row 2'
}
const secret: RuntimeVariable = { name: 'apiKey', value: null, step: 'login', by: 'tests' }

describe('setByLabel', () => {
  it('names the step, what set it, and the row when there was one', () => {
    expect(setByLabel(token)).toBe('login · captured')
    expect(setByLabel(grant)).toBe('setup › grant · tests · row 2')
  })
})

describe('runtimeSummary', () => {
  it('says what set them, in which environment, and when', () => {
    const at = new Date(2026, 9, 12, 9, 4, 31).getTime()
    expect(
      runtimeSummary({ collectionPath: 'x', environment: 'demo', last: 'run', at, variables: [] })
    ).toBe('Run all · demo · 09:04:31')
    expect(
      runtimeSummary({ collectionPath: 'x', environment: null, last: 'send', at, variables: [] })
    ).toBe('Sends · no environment · 09:04:31')
  })
})

describe('filterVariables', () => {
  it('matches the name, the value or the setter, any case, and never a hidden value', () => {
    const all = [token, grant, secret]
    expect(filterVariables(all, '  ')).toBe(all)
    expect(filterVariables(all, 'TOKEN')).toEqual([token])
    expect(filterVariables(all, 'row 2')).toEqual([grant])
    expect(filterVariables(all, 'login')).toEqual([token, secret])
    expect(filterVariables(all, 'null')).toEqual([])
  })
})
