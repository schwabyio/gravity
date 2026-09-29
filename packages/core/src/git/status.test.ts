import { describe, expect, it } from 'vitest'
import { EMPTY_STATUS, isClean, parseStatus } from './status.js'

/** Records as `-z` writes them: each one NUL-terminated. */
const z = (...records: string[]) => records.map((record) => `${record}\0`).join('')

describe('parseStatus', () => {
  it('reads branch, upstream and ahead/behind', () => {
    const status = parseStatus(
      z(
        '# branch.oid 91f73e075f9f8e6a882c5aa69baf4df0bd295042',
        '# branch.head main',
        '# branch.upstream origin/main',
        '# branch.ab +2 -3'
      )
    )
    expect(status).toMatchObject({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 3,
      headOid: '91f73e075f9f8e6a882c5aa69baf4df0bd295042',
      unborn: false,
      upstreamGone: false
    })
    expect(isClean(status)).toBe(true)
  })

  it('knows a branch with no commits yet, and leaves ahead/behind null', () => {
    // Real output from a branch with an upstream configured but no commits yet.
    const status = parseStatus(
      z('# branch.oid (initial)', '# branch.head main', '# branch.upstream origin/main')
    )
    expect(status.unborn).toBe(true)
    expect(status.headOid).toBeNull()
    expect(status.ahead).toBeNull()
    expect(status.behind).toBeNull()
    expect(status.upstreamGone).toBe(false)
  })

  it('knows an upstream that is gone from the remote', () => {
    const status = parseStatus(
      z('# branch.oid abc123', '# branch.head feature', '# branch.upstream origin/feature')
    )
    expect(status.upstreamGone).toBe(true)
  })

  it('recognises a detached HEAD', () => {
    const status = parseStatus(z('# branch.oid abc123', '# branch.head (detached)'))
    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
  })

  it('reads each file: counts, kinds and what is staged', () => {
    const status = parseStatus(
      z(
        '# branch.head main',
        '1 .M N... 100644 100644 100644 aaa bbb checkout/01-create.yml',
        '1 M. N... 100644 100644 100644 ccc ddd checkout/02-capture.yml',
        '1 A. N... 000000 100644 100644 000 eee checkout/03-new.yml',
        '1 .D N... 100644 100644 000000 fff fff checkout/04-gone.yml',
        'u UU N... 100644 100644 100644 100644 eee fff ggg refunds/conflict.yml',
        '? refunds/03-partial.yml'
      )
    )
    expect(status.changed).toBe(4)
    expect(status.conflicted).toBe(1)
    expect(status.untracked).toBe(1)
    expect(isClean(status)).toBe(false)
    expect(status.files.map(({ path, kind, staged }) => [path, kind, staged])).toEqual([
      ['checkout/01-create.yml', 'modified', false],
      ['checkout/02-capture.yml', 'modified', true],
      ['checkout/03-new.yml', 'added', true],
      ['checkout/04-gone.yml', 'deleted', false],
      ['refunds/conflict.yml', 'conflicted', true],
      ['refunds/03-partial.yml', 'untracked', false]
    ])
  })

  it('keeps paths exactly: spaces, non-ASCII, even a newline', () => {
    const status = parseStatus(
      z(
        '1 .M N... 100644 100644 100644 aaa bbb my folder/a request.yml',
        '? café/menu.yml',
        '? odd\nname.yml'
      )
    )
    expect(status.files.map((file) => file.path)).toEqual([
      'my folder/a request.yml',
      'café/menu.yml',
      'odd\nname.yml'
    ])
  })

  it('reads a rename with the path it came from', () => {
    const status = parseStatus(
      z('2 R. N... 100644 100644 100644 aaa bbb R100 new/name.yml', 'old/name.yml', '? after.yml')
    )
    expect(status.changed).toBe(1)
    expect(status.files[0]).toMatchObject({
      path: 'new/name.yml',
      origPath: 'old/name.yml',
      kind: 'renamed',
      staged: true
    })
    expect(status.files[1]?.path).toBe('after.yml')
  })

  it('marks a submodule', () => {
    const status = parseStatus(z('1 .M S.M. 160000 160000 160000 aaa aaa vendor/lib'))
    expect(status.files[0]?.submodule).toBe(true)
  })

  it('reads empty output as a clean, unknown-branch repo', () => {
    expect(parseStatus('')).toEqual(EMPTY_STATUS)
  })
})
