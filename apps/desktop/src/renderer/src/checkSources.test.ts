import { describe, expect, it } from 'vitest'
import type { InheritedLayer } from './inheritance.js'
import { calledChecks, checkFileName, sourceTags } from './checkSources.js'

const layer = (over: Partial<InheritedLayer>): InheritedLayer => ({
  kind: 'collection',
  title: 'collection',
  name: null,
  shared: false,
  used: true,
  ...over
})

const layers = [
  layer({ kind: 'endpoint', title: 'endpoint', name: 'GET /users/{id}', shared: true }),
  layer({ kind: 'base', title: 'base collection', name: 'auth' }),
  layer({})
]

describe('sourceTags', () => {
  it('says nothing of the step’s own checks', () => {
    expect(sourceTags({ script: 'step', line: 2 }, 'step', layers)).toEqual([])
  })

  it('names the layer around the step whose tests made a check', () => {
    expect(sourceTags({ script: 'collection', line: 1 }, 'step', layers)).toEqual(['collection'])
    expect(sourceTags({ script: 'endpoint', line: 1 }, 'step', layers)).toEqual([
      'endpoint GET /users/{id}'
    ])
    expect(sourceTags({ script: 'base', line: 3 }, 'step', layers)).toEqual([
      'base collection auth'
    ])
  })

  it('names the check file that made it, wherever it was called from', () => {
    expect(
      sourceTags(
        { script: 'step', line: 2, check: { file: 'checks/common.js', line: 2 } },
        'step',
        layers
      )
    ).toEqual(['checks/common.js'])
    expect(
      sourceTags(
        { script: 'collection', line: 1, check: { file: '../shared/checks/money.js', line: 4 } },
        'step',
        layers
      )
    ).toEqual(['collection', 'checks/money.js'])
  })
})

describe('the check files a script calls', () => {
  it('finds each checks.<name> once, in order', () => {
    expect(calledChecks('checks.common.ok()\nchecks.money.total(1)\nchecks.common.ok()')).toEqual([
      'common',
      'money'
    ])
    expect(calledChecks('gta.expectResponseStatusCodeToBe(200)')).toEqual([])
  })

  it('names a global project’s file from its checks folder', () => {
    expect(checkFileName('../shared/checks/money.js')).toBe('checks/money.js')
  })
})

describe('sourceTags without a layer to name', () => {
  it('names the request set, or the script, and the check file a check came from', () => {
    expect(sourceTags({ script: 'set', line: 1 }, 'step', [])).toEqual(['reusable requests'])
    expect(sourceTags({ script: 'collection', line: 1 }, 'step', [])).toEqual(['collection'])
    expect(
      sourceTags(
        { script: 'step', line: 1, check: { file: '../shared/checks/money.js', line: 4 } },
        'step',
        layers
      )
    ).toEqual(['checks/money.js'])
    expect(sourceTags(undefined, 'step', layers)).toEqual([])
    // A layer with no name of its own is named by its title alone.
    expect(sourceTags({ script: 'collection', line: 1 }, 'use', layers)).toEqual(['collection'])
  })

  it('leaves a file outside checks/ named as it is, and lists each check file called once', () => {
    expect(checkFileName('helpers/money.js')).toBe('helpers/money.js')
    expect(calledChecks('checks.money.ok(); checks.$x.y(); checks.money.no()')).toEqual([
      'money',
      '$x'
    ])
  })
})
