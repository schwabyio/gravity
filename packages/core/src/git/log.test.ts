import { describe, expect, it } from 'vitest'
import { parseBranches, parseLog } from './log.js'
import { parseCheckAttr, parseLsFilesEol } from './attributes.js'
import { parseProgress } from './progress.js'

describe('parseLog', () => {
  it('reads each commit, marking the ones not pushed', () => {
    const out =
      'aaa\x1fa1\x1fAnn\x1fann@x\x1f2026-09-27T10:00:00+02:00\x1fFix: a | b\x1e\nbbb\x1fb1\x1fBob\x1fbob@x\x1f2026-09-26T10:00:00Z\x1fFirst\x1e\n'
    expect(parseLog(out, new Set(['aaa']))).toEqual([
      {
        oid: 'aaa',
        shortOid: 'a1',
        author: 'Ann',
        email: 'ann@x',
        date: '2026-09-27T10:00:00+02:00',
        subject: 'Fix: a | b',
        pushed: false
      },
      {
        oid: 'bbb',
        shortOid: 'b1',
        author: 'Bob',
        email: 'bob@x',
        date: '2026-09-26T10:00:00Z',
        subject: 'First',
        pushed: true
      }
    ])
  })
})

describe('parseBranches', () => {
  it('lists local branches, then remote ones nothing local tracks', () => {
    const line = (...fields: string[]) => fields.join('\0')
    const out = [
      line('refs/heads/main', 'refs/remotes/origin/main', 'ahead 1', '*', ''),
      line('refs/heads/wip', '', '', ' ', ''),
      line('refs/remotes/origin/HEAD', '', '', ' ', 'refs/remotes/origin/main'),
      line('refs/remotes/origin/main', '', '', ' ', ''),
      line('refs/remotes/origin/wip', '', '', ' ', ''),
      line('refs/remotes/origin/team/feature', '', '', ' ', ''),
      line('refs/remotes/origin/team/x', '', '', ' ', '')
    ].join('\n')
    expect(parseBranches(out, ['origin', 'origin/team'])).toEqual([
      { name: 'main', remote: null, current: true, upstream: 'origin/main', track: 'ahead 1' },
      { name: 'wip', remote: null, current: false, upstream: null, track: '' },
      { name: 'feature', remote: 'origin/team', current: false, upstream: null, track: '' },
      { name: 'x', remote: 'origin/team', current: false, upstream: null, track: '' }
    ])
  })
})

describe('attributes', () => {
  it('reads check-attr triples', () => {
    const out = 'a.yml\0eol\0lf\0a.yml\0text\0auto\0b.yml\0eol\0unspecified\0'
    expect(Object.fromEntries(parseCheckAttr(out))).toEqual({
      'a.yml': { eol: 'lf', text: 'auto' },
      'b.yml': { eol: 'unspecified' }
    })
  })

  it('reads how each file is stored', () => {
    const out =
      'i/crlf  w/crlf  attr/                 \tcollections/a b.yml\0i/lf    w/lf    attr/text=auto eol=lf \tx.yml\0'
    expect(parseLsFilesEol(out)).toEqual([
      { path: 'collections/a b.yml', index: 'crlf', worktree: 'crlf' },
      { path: 'x.yml', index: 'lf', worktree: 'lf' }
    ])
  })
})

describe('parseProgress', () => {
  it('reads a phase and a percentage', () => {
    expect(parseProgress('Receiving objects:  42% (420/1000), 1.2 MiB | 3.4 MiB/s')).toEqual({
      phase: 'Receiving objects',
      percent: 42
    })
    expect(parseProgress('remote: Counting objects: 100% (5/5), done.')).toEqual({
      phase: 'Counting objects',
      percent: 100
    })
    expect(parseProgress("Cloning into 'shop'...")).toEqual({
      phase: "Cloning into 'shop'",
      percent: null
    })
  })
})
