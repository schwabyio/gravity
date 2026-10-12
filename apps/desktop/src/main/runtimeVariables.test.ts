import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core'
import { RuntimeVariables, stepRecorder, type KeptValue } from './runtimeVariables.js'

const FILE = '/work/shop/collections/orders.yml'

const resultOf = (name: string, extra: Partial<RunResult> = {}): RunResult => ({
  item: { path: FILE, name, seq: null },
  request: { method: 'GET', url: '', headers: [], body: null },
  response: null,
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 1,
  ...extra
})

const kept = (name: string, value: string, step = 'login'): KeptValue => ({
  name,
  value,
  shown: value,
  step,
  by: 'tests'
})

describe('stepRecorder', () => {
  it('gives what was set since the last result to the step that result is of', () => {
    const recorder = stepRecorder([])
    recorder.onSet({ name: 'authToken', value: 'tok', source: 'captured' })
    expect(recorder.take(resultOf('login'))).toEqual([
      { name: 'authToken', value: 'tok', shown: 'tok', step: 'login', by: 'captured' }
    ])
    recorder.onSet({ name: 'grantId', value: 7, source: 'tests' })
    expect(recorder.take(resultOf('grant', { stage: 'setup' }), { index: 2 })).toEqual([
      { name: 'grantId', value: 7, shown: '7', step: 'setup › grant', by: 'tests', row: 'row 2' }
    ])
    // A step that set nothing has nothing.
    expect(recorder.take(resultOf('get orders'))).toEqual([])
  })

  it('hides a secret in a value, and the whole of one with a secret name', () => {
    const recorder = stepRecorder([['apiKey', 's3cret']])
    recorder.onSet({ name: 'header', value: 'Bearer s3cret', source: 'pre-request' })
    recorder.onSet({ name: 'apiKey', value: 'other', source: 'tests' })
    recorder.onSet({ name: 'none', value: null, source: 'tests' })
    const [header, apiKey, none] = recorder.take(resultOf('login'))
    expect(header).toMatchObject({ value: 'Bearer s3cret', shown: 'Bearer [secret: apiKey]' })
    expect(apiKey).toMatchObject({ value: 'other', shown: null })
    expect(none).toMatchObject({ value: null, shown: 'null' })
  })
})

describe('RuntimeVariables', () => {
  it('carries what Sends set into the next Send, the last value set winning', () => {
    const store = new RuntimeVariables()
    store.begin(FILE, 'demo', 'send')
    store.add(FILE, [kept('authToken', 'one'), kept('orderId', '8812', 'create order')])
    store.begin(FILE, 'demo', 'send')
    store.add(FILE, [kept('authToken', 'two')])
    expect(store.carried(FILE, 'demo')).toEqual([
      { name: 'authToken', value: 'two', source: 'set by login · tests', secret: false },
      { name: 'orderId', value: '8812', source: 'set by create order · tests', secret: false }
    ])
    // In the order first set.
    expect(store.view(FILE, 'demo')?.variables.map((v) => v.name)).toEqual(['authToken', 'orderId'])
  })

  it('starts Run all from nothing, and keeps what it sets after', () => {
    const store = new RuntimeVariables()
    store.begin(FILE, 'demo', 'send')
    store.add(FILE, [kept('old', 'x')])
    store.begin(FILE, 'demo', 'run')
    expect(store.carried(FILE, 'demo')).toEqual([])
    store.add(FILE, [kept('authToken', 'tok')])
    expect(store.view(FILE, 'demo')).toMatchObject({
      collectionPath: FILE,
      environment: 'demo',
      last: 'run',
      variables: [{ name: 'authToken', value: 'tok', step: 'login', by: 'tests' }]
    })
  })

  it('forgets them in another environment, and on Clear, saying so', () => {
    const store = new RuntimeVariables()
    const told: string[] = []
    store.onChange((file) => told.push(file))
    store.begin(FILE, 'demo', 'send')
    store.add(FILE, [kept('authToken', 'tok')])
    expect(store.carried(FILE, 'staging')).toEqual([])
    expect(store.view(FILE, 'demo')).toBeNull()

    store.begin(FILE, 'demo', 'send')
    store.add(FILE, [kept('authToken', 'tok')])
    store.clear(FILE)
    expect(store.current(FILE)).toBeNull()
    // begin, add, the switch; begin, add, clear.
    expect(told).toHaveLength(6)
  })

  it('marks a carried value holding a secret, and shows none of a secret name', () => {
    const store = new RuntimeVariables()
    store.begin(FILE, null, 'send')
    store.add(FILE, [
      { ...kept('header', 'Bearer s3cret'), shown: 'Bearer [secret: apiKey]' },
      { ...kept('apiKey', 'other'), shown: null }
    ])
    expect(store.carried(FILE, null).map((value) => value.secret)).toEqual([true, true])
    expect(store.view(FILE, null)?.variables.map((v) => v.value)).toEqual([
      'Bearer [secret: apiKey]',
      null
    ])
  })
})
