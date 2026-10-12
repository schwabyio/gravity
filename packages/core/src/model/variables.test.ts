import { describe, expect, it } from 'vitest'
import {
  fileSetters,
  namesSetIn,
  namesStepsSet,
  setByOf,
  setByText,
  settersIn,
  type UsedFile
} from './variables.js'

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

describe('settersIn', () => {
  it('finds a name a param holds, as a reusable requests file sets one', () => {
    const script = [
      'gta.set(params.saveTokenAs, res.body.accessToken)',
      "gta.expectResponseBodyToHaveProperty('id', params.saveIdAs, 'setAsCollectionVariable')",
      "gta.set('plain', 1)"
    ].join('\n')
    expect(settersIn(script, 'tests')).toEqual([
      { param: 'saveTokenAs', by: 'tests' },
      { name: 'plain', by: 'tests' },
      { param: 'saveIdAs', by: 'captured' }
    ])
  })
})

describe('fileSetters', () => {
  it("names each by its step, and the file's own scripts by none", () => {
    expect(
      fileSetters({
        before: { script: "gta.set('traceId', gta.uuid())" },
        steps: [
          { name: 'create token', POST: '/token', tests: 'gta.set(params.saveTokenAs, 1)' },
          { GET: '/profile' }
        ]
      })
    ).toEqual([
      { name: 'traceId', by: 'pre-request', step: null },
      { param: 'saveTokenAs', by: 'tests', step: 'create token' }
    ])
  })
})

describe('namesStepsSet with reusable requests files', () => {
  const createUser: UsedFile = {
    params: { saveTokenAs: { required: true }, saveIdAs: { default: 'userId' }, other: null },
    steps: 2,
    setters: [
      { name: 'traceId', by: 'pre-request', step: null },
      { param: 'saveTokenAs', by: 'tests', step: 'create token' },
      { param: 'saveIdAs', by: 'captured', step: 'get profile' },
      { param: 'undeclared', by: 'tests', step: 'get profile' },
      { name: 'lastProfile', by: 'tests', step: 'get profile' }
    ]
  }
  const fileOf = (reference: string) => (reference === 'create-user' ? createUser : null)

  it("reads the names its params hold from the use step's with:, else their defaults", () => {
    const found = namesStepsSet(
      {
        steps: [
          { use: 'create-user', name: 'user 1', with: { saveTokenAs: 'token1' } },
          { use: 'missing', with: { saveTokenAs: 'never' } }
        ]
      },
      fileOf
    )
    expect(found).toEqual({
      traceId: { step: 'user 1', by: 'pre-request' },
      token1: { step: 'user 1 › create token', by: 'tests' },
      userId: { step: 'user 1 › get profile', by: 'captured' },
      lastProfile: { step: 'user 1 › get profile', by: 'tests' }
    })
  })

  it("names an unnamed use step's steps as reports do, and skips a name worked out later", () => {
    const found = namesStepsSet(
      {
        setup: [
          { use: 'create-user', with: { saveTokenAs: '{{tokenName}}', saveIdAs: 'adminId' } }
        ],
        steps: []
      },
      fileOf
    )
    expect(found).toEqual({
      traceId: { step: 'setup › create-user', by: 'pre-request' },
      adminId: { step: 'setup › get profile', by: 'captured' },
      lastProfile: { step: 'setup › get profile', by: 'tests' }
    })
  })

  it('names a file of one step by the use step alone', () => {
    const one: UsedFile = { ...createUser, steps: 1 }
    expect(
      namesStepsSet(
        { steps: [{ use: 'one', name: 'sign in', with: { saveTokenAs: 'token' } }] },
        () => one
      ).token
    ).toEqual({ step: 'sign in', by: 'tests' })
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
