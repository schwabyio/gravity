import { describe, expect, it } from 'vitest'
import { codeTokens, markCode, markInlineCode, markText, type CodeToken } from './markdownMarks.js'

/** Tokens as `text:kind`, the uncoloured as their text alone, leaving out whitespace. */
const shown = (tokens: CodeToken[] | null) =>
  tokens!
    .filter((token) => token.text.trim() !== '')
    .map((token) => (token.kind ? `${token.text}:${token.kind}` : token.text))

describe('markText', () => {
  it('marks each {{variable}}, keeping the text as written', () => {
    expect(markText('as {{adminUser}}, then {{ orderId }}.')).toEqual([
      { text: 'as ', mark: null },
      { text: '{{adminUser}}', mark: 'variable' },
      { text: ', then ', mark: null },
      { text: '{{ orderId }}', mark: 'variable' },
      { text: '.', mark: null }
    ])
    expect(markText('no variables, {{ }} or {{a b}}')).toEqual([
      { text: 'no variables, {{ }} or {{a b}}', mark: null }
    ])
  })
})

describe('markInlineCode', () => {
  it('marks a method the code starts with, and the variables after it', () => {
    expect(markInlineCode('GET /orders/{{orderId}}')).toEqual([
      { text: 'GET', mark: 'method', method: 'GET' },
      { text: ' /orders/', mark: null },
      { text: '{{orderId}}', mark: 'variable' }
    ])
    expect(markInlineCode('DELETE')).toEqual([{ text: 'DELETE', mark: 'method', method: 'DELETE' }])
    // Only a method as its own word, in capitals.
    expect(markInlineCode('GETTER')).toEqual([{ text: 'GETTER', mark: null }])
    expect(markInlineCode('get /orders')).toEqual([{ text: 'get /orders', mark: null }])
  })

  it('marks code that is a status code with its class', () => {
    expect(markInlineCode('201')).toEqual([{ text: '201', mark: 'status', status: '2xx' }])
    expect(markInlineCode('404 Not Found')).toEqual([
      { text: '404 Not Found', mark: 'status', status: '4xx' }
    ])
    expect(markInlineCode('5xx')).toEqual([{ text: '5xx', mark: 'status', status: '5xx' }])
    for (const text of ['200 OK, 201', '2000', '600', 'id 201']) {
      expect(markInlineCode(text)).toEqual([{ text, mark: null }])
    }
  })
})

describe('codeTokens: JSON', () => {
  it('reads names, strings, numbers, literals and punctuation', () => {
    expect(shown(codeTokens('{"a": "s", "n": [-1.5e3, true, null]}', 'json'))).toEqual([
      '{:punctuation',
      '"a":name',
      '::punctuation',
      '"s":string',
      ',:punctuation',
      '"n":name',
      '::punctuation',
      '[:punctuation',
      '-1.5e3:number',
      ',:punctuation',
      'true:literal',
      ',:punctuation',
      'null:literal',
      ']:punctuation',
      '}:punctuation'
    ])
  })

  it('reads a bare variable as one token, and the names after it as names', () => {
    expect(shown(codeTokens('{"qty": {{qty}},\n "price": 1.0}', 'JSON'))).toEqual([
      '{:punctuation',
      '"qty":name',
      '::punctuation',
      '{{qty}}',
      ',:punctuation',
      '"price":name',
      '::punctuation',
      '1.0:number',
      '}:punctuation'
    ])
  })

  it('keeps every character: the tokens joined are the text', () => {
    const text = '{\n  "a": "x \\" y",\n  "b": {{b}}, oops\n}'
    expect(
      codeTokens(text, 'json')!
        .map((token) => token.text)
        .join('')
    ).toBe(text)
  })
})

describe('codeTokens: XML', () => {
  it('reads tags, attributes, values, comments and declarations; text is plain', () => {
    expect(
      shown(
        codeTokens(
          '<?xml version="1.0"?><!-- an order --><order id="{{id}}" a=\'1\'>2<b/></order>',
          'xml'
        )
      )
    ).toEqual([
      '<?xml version="1.0"?>:meta',
      '<!-- an order -->:comment',
      '<:punctuation',
      'order:tag',
      'id:attribute',
      '=:punctuation',
      '"{{id}}":string',
      'a:attribute',
      '=:punctuation',
      "'1':string",
      '>:punctuation',
      '2',
      '<:punctuation',
      'b:tag',
      '/>:punctuation',
      '</:punctuation',
      'order:tag',
      '>:punctuation'
    ])
  })

  it('keeps every character, unclosed pieces included', () => {
    for (const text of ['<a x="1>2">t</a>', '<a', '<!-- open', '<a b="open']) {
      expect(
        codeTokens(text, 'xml')!
          .map((token) => token.text)
          .join('')
      ).toBe(text)
    }
  })
})

describe('codeTokens: other languages', () => {
  it('reads none: the renderer colours them, or shows them plain', () => {
    expect(codeTokens('const a = 1', 'js')).toBeNull()
    expect(codeTokens('{"a": 1}', null)).toBeNull()
  })
})

describe('markCode', () => {
  it('marks the variables inside tokens, keeping each token’s kind', () => {
    expect(
      markCode([
        { text: '"Bearer {{token}}"', kind: 'string' },
        { text: '{{qty}}', kind: null }
      ])
    ).toEqual([
      { text: '"Bearer ', kind: 'string', variable: false },
      { text: '{{token}}', kind: 'string', variable: true },
      { text: '"', kind: 'string', variable: false },
      { text: '{{qty}}', kind: null, variable: true }
    ])
  })
})
