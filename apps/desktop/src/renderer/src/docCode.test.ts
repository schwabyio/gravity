import { describe, expect, it } from 'vitest'
import { docCodeMarks } from './docCode.js'

/** Marks as `text:kind`, `{{var}}*` for a variable, leaving out whitespace and plain text. */
const shown = (text: string, language: string | null) =>
  docCodeMarks(text, language)
    .filter((mark) => mark.kind || mark.variable)
    .map((mark) => `${mark.text}${mark.kind ? `:${mark.kind}` : ''}${mark.variable ? '*' : ''}`)

describe('docCodeMarks', () => {
  it('colours JavaScript as the scripts’ editor does, its variables marked', () => {
    expect(
      shown(
        "// check\nconst id = gta.get('orderId')\nif (id === null) fail(`{{orderId}}`, 2)",
        'js'
      )
    ).toEqual([
      '// check:comment',
      'const:keyword',
      '=:punctuation',
      '.:punctuation',
      'get:function',
      '(:punctuation',
      "'orderId':string",
      '):punctuation',
      'if:keyword',
      '(:punctuation',
      '===:punctuation',
      'null:literal',
      '):punctuation',
      'fail:function',
      '(:punctuation',
      '`:string',
      '{{orderId}}:string*',
      '`:string',
      ',:punctuation',
      '2:number',
      '):punctuation'
    ])
  })

  it('reads TypeScript, in any case of its name', () => {
    expect(shown('let n: number = 1', 'TS')).toContain('let:keyword')
  })

  it('colours JSON and XML as core reads them, for a report too', () => {
    expect(shown('{"qty": {{qty}}}', 'json')).toEqual([
      '{:punctuation',
      '"qty":name',
      '::punctuation',
      '{{qty}}*',
      '}:punctuation'
    ])
    expect(shown('<a b="1"/>', 'xml')).toEqual([
      '<:punctuation',
      'a:tag',
      'b:attribute',
      '=:punctuation',
      '"1":string',
      '/>:punctuation'
    ])
  })

  it('shows any other language plain, its variables still marked', () => {
    expect(docCodeMarks('curl {{baseUrl}}/orders', 'sh')).toEqual([
      { text: 'curl ', kind: null, variable: false },
      { text: '{{baseUrl}}', kind: null, variable: true },
      { text: '/orders', kind: null, variable: false }
    ])
    expect(shown('plain', null)).toEqual([])
  })

  it('keeps every character: the marks joined are the code', () => {
    const code = "const a = { b: [1, 'x'] } // done\n<tag/>"
    for (const language of ['js', 'json', 'xml', null]) {
      expect(
        docCodeMarks(code, language)
          .map((mark) => mark.text)
          .join('')
      ).toBe(code)
    }
  })
})
