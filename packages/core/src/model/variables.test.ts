import { describe, expect, it } from 'vitest'
import { namesSetIn, namesStepsSet, setByOf, setByText } from './variables.js'

describe('namesSetIn', () => {
  it('finds literal gta.set names, in any quotes', () => {
    expect(
      namesSetIn("gta.set('a', 1)\ngta.set(\"b\", 2)\ngta.set(`c`, 3, { scope: 'run' })", 'tests')
    ).toEqual([
      { name: 'a', by: 'tests' },
      { name: 'b', by: 'tests' },
      { name: 'c', by: 'tests' }
    ])
  })

  it('finds checks capturing into a name, whatever the path is written as', () => {
    const script = [
      "gta.expectResponseBodyToHaveProperty('token', 'authToken', 'setAsCollectionVariable')",
      "gta.expectResponseBodyToHaveProperty(['jwt', 'sub'], \"userId\", 'setAsEnvironmentVariable')",
      "gta.expectResponseBodyToHaveProperty('id', 7)"
    ].join('\n')
    expect(namesSetIn(script, 'tests')).toEqual([
      { name: 'authToken', by: 'captured' },
      { name: 'userId', by: 'captured' }
    ])
  })

  it('leaves out a name worked out as the script runs, and captures before a request', () => {
    expect(namesSetIn('gta.set(params.saveAs, res.body.token)', 'tests')).toEqual([])
    expect(
      namesSetIn(
        "gta.expectResponseBodyToHaveProperty('a', 'b', 'setAsCollectionVariable')",
        'pre-request'
      )
    ).toEqual([])
    expect(namesSetIn(undefined, 'tests')).toEqual([])
  })
})

describe('namesStepsSet', () => {
  it('names each by the first step to set it, in run order, as reports name steps', () => {
    const found = namesStepsSet({
      setup: [{ name: 'grant', POST: '/grants', tests: "gta.set('grantId', res.body.id)" }],
      steps: [
        {
          name: 'login',
          POST: '/login',
          tests:
            "gta.expectResponseBodyToHaveProperty('token', 'authToken', 'setAsCollectionVariable')"
        },
        { GET: '/orders', before: { script: "gta.set('traceId', gta.uuid())" } },
        { name: 'again', POST: '/login', tests: "gta.set('authToken', 'x')" }
      ],
      tests: "gta.set('lastStatus', res.status)"
    })
    expect(found).toEqual({
      grantId: { step: 'setup › grant', by: 'tests' },
      authToken: { step: 'login', by: 'captured' },
      traceId: { step: 'GET /orders', by: 'pre-request' },
      lastStatus: { step: 'the collection', by: 'tests' }
    })
  })
})

describe('setByOf and setByText', () => {
  it('reads a scope source as what set the value, and says it', () => {
    expect(setByOf('tests')).toBe('tests')
    expect(setByOf('pre-request')).toBe('pre-request')
    expect(setByOf('captured (environment)')).toBe('captured')
    expect(setByText('login', 'captured')).toBe('set by login · captured')
  })
})
