import { describe, expect, it } from 'vitest'
import type { RunResult } from '@schwabyio/gravity-core/model'
import type { RequestSetView } from '@shared/ipc.js'
import {
  childKey,
  childResultsOf,
  itemKey,
  itemResultsOf,
  referenceFor,
  resolveSet,
  stepOfKey,
  summaryOfFile,
  summaryOfSet
} from './reuse.js'

const result = (index: number): RunResult => ({
  item: { path: null, name: 'remove', seq: null },
  request: { method: 'DELETE', url: `http://x/${index}`, headers: [], body: null },
  response: null,
  assertions: [],
  error: null,
  status: 'pass',
  durationMs: 1,
  forEach: { index, of: 3, item: String(index) }
})

describe('forEach results', () => {
  it('are kept one per item, under the step, and read back in order', () => {
    const results = { [itemKey('step-1', 1)]: result(1), [itemKey('step-1', 0)]: result(0) }
    expect(itemResultsOf(results, 'step-1').map((r) => r.forEach?.index)).toEqual([0, 1])
    expect(itemResultsOf(results, 'step-2')).toEqual([])
  })

  it('belong to their step, as a use step’s requests do', () => {
    expect(stepOfKey(itemKey('step-1', 2))).toBe('step-1')
    expect(stepOfKey(childKey('step-3', 0))).toBe('step-3')
    expect(stepOfKey('step-4')).toBe('step-4')
  })
})

const set = (name: string, source: RequestSetView['source']): RequestSetView => ({
  name,
  path: `/${source}/requests/${name}.yml`,
  source,
  title: name,
  params: {},
  steps: [{ label: 'login', method: 'POST' }]
})

describe('request sets', () => {
  const sets = [set('login', 'project'), set('login', 'global'), set('logout', 'global')]

  it('resolve as the runner finds them: the project’s first, global: only the global project’s', () => {
    expect(resolveSet(sets, 'login')?.source).toBe('project')
    expect(resolveSet(sets, 'global:login')?.source).toBe('global')
    expect(resolveSet(sets, 'logout')?.source).toBe('global')
    expect(resolveSet(sets, 'global:nothing')).toBeNull()
    expect(resolveSet(sets, 'nothing')).toBeNull()
  })

  it('are named plainly, unless the project’s own set of that name would be found instead', () => {
    expect(referenceFor(sets, sets[0]!)).toBe('login')
    expect(referenceFor(sets, sets[1]!)).toBe('global:login')
    expect(referenceFor(sets, sets[2]!)).toBe('logout')
  })

  it('keep a use step’s results one per request, in order, gaps and all', () => {
    const results = { [childKey('step-1', 1)]: result(1) }
    expect(childResultsOf(results, 'step-1', 3)).toEqual([undefined, result(1), undefined])
  })

  it('open like any collection, a problem and all', () => {
    expect(summaryOfSet(sets[0]!)).toEqual({
      path: '/project/requests/login.yml',
      relativePath: 'requests/login.yml',
      directory: null,
      name: 'login',
      stepCount: 1,
      tags: [],
      environmentsPath: null,
      problems: []
    })
    expect(
      summaryOfFile(
        {
          path: '/p/bases/authed.yml',
          name: 'authed',
          title: 'authed',
          stepCount: 0,
          problem: 'no'
        },
        'bases'
      ).problems
    ).toEqual([{ path: 'bases/authed.yml', message: 'no' }])
  })
})
