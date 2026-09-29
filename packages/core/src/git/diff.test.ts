import { describe, expect, it } from 'vitest'
import { addedFileDiff, parseNumstat, parseUnifiedDiff } from './diff.js'

describe('parseUnifiedDiff', () => {
  it('numbers each line from its hunk header', () => {
    const { binary, hunks } = parseUnifiedDiff(
      [
        'diff --git a/x.yml b/x.yml',
        'index 1..2 100644',
        '--- a/x.yml',
        '+++ b/x.yml',
        '@@ -3,3 +3,3 @@ steps:',
        ' keep',
        '-old',
        '+new',
        ' --- a line that looks like a header',
        ''
      ].join('\n')
    )
    expect(binary).toBe(false)
    expect(hunks).toEqual([
      {
        header: '@@ -3,3 +3,3 @@ steps:',
        lines: [
          { kind: 'context', text: 'keep', oldLine: 3, newLine: 3 },
          { kind: 'del', text: 'old', oldLine: 4, newLine: null },
          { kind: 'add', text: 'new', oldLine: null, newLine: 4 },
          { kind: 'context', text: '--- a line that looks like a header', oldLine: 5, newLine: 5 }
        ]
      }
    ])
  })

  it('knows a binary file', () => {
    expect(parseUnifiedDiff('diff --git a/i b/i\nBinary files a/i and b/i differ\n').binary).toBe(
      true
    )
  })
})

describe('addedFileDiff', () => {
  it('shows every line added, and a missing final newline', () => {
    const { hunks } = addedFileDiff(Buffer.from('a\nb'))
    expect(hunks[0]?.header).toBe('@@ -0,0 +1,2 @@')
    expect(hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ['add', 'a'],
      ['add', 'b'],
      ['meta', 'No newline at end of file']
    ])
  })

  it('treats a NUL byte as binary, and an empty file as no lines', () => {
    expect(addedFileDiff(Buffer.from([1, 0, 2])).binary).toBe(true)
    expect(addedFileDiff(Buffer.from('')).hunks).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('counts changed lines, and knows binary', () => {
    expect(parseNumstat('3\t2\tx.yml\0')).toEqual({ binary: false, changedLines: 5 })
    expect(parseNumstat('1\t1\t\0old.yml\0new.yml\0')).toEqual({ binary: false, changedLines: 2 })
    expect(parseNumstat('-\t-\ti.png\0')).toEqual({ binary: true, changedLines: 0 })
  })
})
