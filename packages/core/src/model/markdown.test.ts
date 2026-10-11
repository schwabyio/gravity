import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown.js'

describe('parseMarkdown', () => {
  it('reads headings, paragraphs, rules, quotes and fenced code', () => {
    expect(
      parseMarkdown('# Title\n\nSome\nwrapped text.\n\n---\n\n> quoted\n\n```js\nconst a = 1\n```')
    ).toEqual([
      { type: 'heading', level: 1, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Some wrapped text.' }] },
      { type: 'rule' },
      {
        type: 'quote',
        blocks: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }]
      },
      { type: 'code', language: 'js', text: 'const a = 1' }
    ])
  })

  it('nests lists by indentation, and reads tables', () => {
    const [list, table] = parseMarkdown(
      '- one\n  - inner\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |'
    )
    expect(list).toMatchObject({
      type: 'list',
      ordered: false,
      items: [
        {
          content: [{ text: 'one' }],
          children: { type: 'list', items: [{ content: [{ text: 'inner' }] }] }
        },
        { content: [{ text: 'two' }], children: null }
      ]
    })
    expect(table).toMatchObject({
      type: 'table',
      header: [[{ text: 'a' }], [{ text: 'b' }]],
      rows: [[[{ text: '1' }], [{ text: '2' }]]]
    })
  })

  it('reads inline code first, so markers inside it stay literal', () => {
    expect(parseInline('call `**x**` then **bold** and _em_')).toEqual([
      { type: 'text', text: 'call ' },
      { type: 'code', text: '**x**' },
      { type: 'text', text: ' then ' },
      { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'em', children: [{ type: 'text', text: 'em' }] }
    ])
  })

  it('makes links of http(s) only, and leaves any other as its text', () => {
    expect(parseInline('[docs](https://x.test) [bad](file:///etc/passwd)')).toEqual([
      { type: 'link', label: 'docs', href: 'https://x.test' },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'bad (file:///etc/passwd)' }
    ])
  })

  it('reads GitHub callouts: a quote whose first line is [!KIND], in any case', () => {
    expect(
      parseMarkdown('> [!warning]\n> Needs the **orders:write** scope.\n> - one\n\n> [!TIP]')
    ).toEqual([
      {
        type: 'callout',
        kind: 'warning',
        blocks: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Needs the ' },
              { type: 'strong', children: [{ type: 'text', text: 'orders:write' }] },
              { type: 'text', text: ' scope.' }
            ]
          },
          {
            type: 'list',
            ordered: false,
            items: [{ content: [{ type: 'text', text: 'one' }], children: null }]
          }
        ]
      },
      { type: 'callout', kind: 'tip', blocks: [] }
    ])
    for (const kind of ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']) {
      expect(parseMarkdown(`> [!${kind}]\n> x`)[0]).toMatchObject({ kind: kind.toLowerCase() })
    }
  })

  it('leaves a quote a quote when its marker is unknown, or not alone on its line', () => {
    for (const source of ['> [!DANGER]\n> x', '> [!NOTE] inline\n> x', '> x\n> [!NOTE]']) {
      expect(parseMarkdown(source)[0]).toMatchObject({ type: 'quote' })
    }
  })

  it('keeps markup as text: a renderer escapes it', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] }
    ])
  })
})
