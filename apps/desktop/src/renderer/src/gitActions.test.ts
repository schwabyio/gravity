import { describe, expect, it } from 'vitest'
import type { GitStatusView } from '@shared/ipc.js'
import { diverged, pullState, pushState, rebaseQuestion } from './gitActions.js'

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
  projectFiles: {},
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

describe('what blocks a pull or a push, whatever the counts', () => {
  it('says so for an operation in progress, conflicts, a detached HEAD and no commit yet', () => {
    const cases: Array<[Partial<GitStatusView>, string]> = [
      [{ operation: 'rebase' }, 'A rebase is in progress: finish it in your git tool first'],
      [{ conflicted: 2 }, 'Resolve the conflicts in your git tool first'],
      [{ detached: true }, 'HEAD is detached: create a branch first'],
      [{ unborn: true }, 'Make a first commit first']
    ]
    for (const [over, why] of cases) {
      expect(pullState(git({ ...over, behind: 1 }), false)).toEqual({
        enabled: false,
        tooltip: `Cannot pull. ${why}`,
        count: 1
      })
      expect(pushState(git({ ...over, ahead: 2 }), false, null)).toEqual({
        enabled: false,
        tooltip: `Cannot push. ${why}`,
        count: 2
      })
    }
  })

  it('cannot pull from an upstream gone from the remote, and pulls one commit by name', () => {
    expect(pullState(git({ upstreamGone: true }), false).tooltip).toBe(
      'Cannot pull: origin/main is gone from the remote'
    )
    expect(pullState(git({ behind: 1 }), false).tooltip).toBe(
      'Pull 1 commit from origin/main (fast-forward)'
    )
    expect(pullState(git({ ahead: null, behind: null }), false)).toEqual({
      enabled: true,
      tooltip: 'Pull from origin/main',
      count: 0
    })
  })

  it('publishes a branch to the remote asked for, else origin, else the first one', () => {
    const unpublished = { upstream: null, remotes: ['upstream', 'origin'] }
    expect(pushState(git(unpublished), false, 'upstream').tooltip).toBe('Publish main to upstream')
    expect(pushState(git(unpublished), false, null).tooltip).toBe('Publish main to origin')
    expect(pushState(git({ ...unpublished, remotes: ['fork'] }), false, null).tooltip).toBe(
      'Publish main to fork'
    )
    expect(pushState(git({ upstreamGone: true, branch: null }), true, null)).toEqual({
      enabled: false,
      tooltip: 'Publish this branch to origin',
      count: 0
    })
  })

  it('asks before a pull that rebases', () => {
    expect(diverged(git({ ahead: 1, behind: 2 }))).toBe(true)
    expect(diverged(git({ ahead: 1 }))).toBe(false)
    expect(rebaseQuestion(git({ ahead: 1, behind: 2 }))).toBe(
      'Your branch and origin/main have both moved on. Pull replays your 1 commit on top of their 2 commits (a rebase). If they conflict, nothing is changed.\n\nPull now?'
    )
  })
})
