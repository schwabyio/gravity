import { describe, expect, it } from 'vitest'
import type { GitStatusView } from '@shared/ipc.js'
import { pullState, pushState } from './gitActions.js'

const git = (over: Partial<GitStatusView> = {}): GitStatusView => ({
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  changed: 0,
  untracked: 0,
  conflicted: 0,
  clean: true,
  unborn: false,
  upstreamGone: false,
  operation: null,
  remotes: ['origin'],
  projectChanges: 0,
  fetchProblem: null,
  ...over
})

describe('pullState', () => {
  it('fast-forwards, even over changes of your own', () => {
    const state = pullState(git({ behind: 2, changed: 1, clean: false }), false)
    expect(state).toEqual({
      enabled: true,
      tooltip: 'Pull 2 commits from origin/main (fast-forward)',
      count: 2
    })
  })

  it('rebases when both moved on, but not over uncommitted changes', () => {
    expect(pullState(git({ ahead: 1, behind: 1 }), false).tooltip).toMatch(/rebase/)
    expect(pullState(git({ ahead: 1, behind: 1, changed: 2 }), false).enabled).toBe(false)
  })

  it('cannot pull without an upstream, mid-merge, or while busy', () => {
    expect(pullState(git({ upstream: null }), false)).toMatchObject({ enabled: false })
    expect(pullState(git({ operation: 'merge' }), false).tooltip).toMatch(/merge is in progress/)
    expect(pullState(git(), true).enabled).toBe(false)
  })
})

describe('pushState', () => {
  it('pushes what is ahead, and publishes a branch with no upstream', () => {
    expect(pushState(git({ ahead: 1 }), false, null)).toEqual({
      enabled: true,
      tooltip: 'Push 1 commit to origin/main',
      count: 1
    })
    expect(pushState(git({ upstream: null, branch: 'feature/x' }), false, null).tooltip).toBe(
      'Publish feature/x to origin'
    )
  })

  it('asks for a pull first when the remote moved on, and has nothing to do when level', () => {
    expect(pushState(git({ ahead: 1, behind: 1 }), false, null).tooltip).toMatch(/^Pull first/)
    expect(pushState(git(), false, null).enabled).toBe(false)
    expect(pushState(git({ remotes: [] }), false, null).tooltip).toMatch(/no remote/)
  })
})
