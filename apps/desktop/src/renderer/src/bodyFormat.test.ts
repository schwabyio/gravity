import { describe, expect, it } from 'vitest'
import { beautifierFor, beautifyJson, beautifyXml } from './bodyFormat.js'

const ok = (result: ReturnType<typeof beautifyJson>): string => {
  if (!result.ok) throw new Error(result.message)
  return result.text
}

describe('beautifyJson', () => {
  it('indents two spaces a level, keeping empty objects and lists short', () => {
    expect(ok(beautifyJson('{"a":1,"b":[true,null,{}],"c":{"d":[]}}'))).toBe(
      [
        '{',
        '  "a": 1,',
        '  "b": [',
        '    true,',
        '    null,',
        '    {}',
        '  ],',
        '  "c": {',
        '    "d": []',
        '  }',
        '}'
      ].join('\n')
    )
  })

  it('keeps every value as written: numbers, escapes and long ids', () => {
    expect(
      ok(beautifyJson('{"n":1.0,"e":1E+3,"id":12345678901234567890,"s":"a\\"b\\u00e9"}'))
    ).toBe('{\n  "n": 1.0,\n  "e": 1E+3,\n  "id": 12345678901234567890,\n  "s": "a\\"b\\u00e9"\n}')
  })

  it('keeps variables, in strings and bare, and as a name', () => {
    expect(ok(beautifyJson('{"user":"{{adminUser}}","count":{{count}},{{key}}:[{{item}}]}'))).toBe(
      '{\n  "user": "{{adminUser}}",\n  "count": {{count}},\n  {{key}}: [\n    {{item}}\n  ]\n}'
    )
    expect(ok(beautifyJson('  {{body}}\n'))).toBe('{{body}}')
  })

  it('re-indents a body already laid out another way', () => {
    expect(ok(beautifyJson('{\n    "a" :  [ 1 ,\n2 ]\n}'))).toBe(
      '{\n  "a": [\n    1,\n    2\n  ]\n}'
    )
  })

  it('says where a body is not JSON, and changes nothing', () => {
    expect(beautifyJson('{\n  "a": 1,\n  "b" 2\n}')).toEqual({
      ok: false,
      message: 'Not valid JSON: Expected : after a name (line 3, column 7)'
    })
    expect(beautifyJson('{"a": [1, 2}')).toEqual({
      ok: false,
      message: 'Not valid JSON: Expected , or ] (line 1, column 12)'
    })
    expect(beautifyJson('{"a": 1')).toMatchObject({
      message: 'Not valid JSON: Expected , or }, but the body ends (line 1, column 8)'
    })
    expect(beautifyJson('{"a": "open}')).toMatchObject({
      message: 'Not valid JSON: A string is never closed (line 1, column 7)'
    })
    expect(beautifyJson('{"a": 1} x')).toMatchObject({ ok: false })
    expect(beautifyJson('')).toMatchObject({ ok: false })
  })
})

describe('beautifyXml', () => {
  it('puts each element on its line, with text inside its tags', () => {
    expect(
      ok(
        beautifyXml(
          '<?xml version="1.0"?><order id="{{orderId}}"><sku>ACME-1</sku><qty>2</qty><gift/><note></note></order>'
        )
      )
    ).toBe(
      [
        '<?xml version="1.0"?>',
        '<order id="{{orderId}}">',
        '  <sku>ACME-1</sku>',
        '  <qty>2</qty>',
        '  <gift/>',
        '  <note></note>',
        '</order>'
      ].join('\n')
    )
  })

  it('re-indents a body already laid out, and keeps comments, CDATA and > in a value', () => {
    expect(
      ok(
        beautifyXml(
          '<a>\n      <!-- why -->\n <b x="1>0">\n   text\n </b>\n<c><![CDATA[<raw>]]></c></a>'
        )
      )
    ).toBe(
      ['<a>', '  <!-- why -->', '  <b x="1>0">text</b>', '  <c><![CDATA[<raw>]]></c>', '</a>'].join(
        '\n'
      )
    )
  })

  it('keeps text on one line as written', () => {
    expect(ok(beautifyXml('<a><b>  spaced  </b></a>'))).toBe('<a>\n  <b>  spaced  </b>\n</a>')
  })

  it('keeps a DOCTYPE with an internal subset whole', () => {
    expect(ok(beautifyXml('<!DOCTYPE a [<!ENTITY e "x">]><a/>'))).toBe(
      '<!DOCTYPE a [<!ENTITY e "x">]>\n<a/>'
    )
  })

  it('says where a body is not XML', () => {
    expect(beautifyXml('<a>\n  <b></c>\n</a>')).toEqual({
      ok: false,
      message: 'Not valid XML: </c> closes <b> (line 2, column 6)'
    })
    expect(beautifyXml('<a><b></b>')).toMatchObject({
      message: 'Not valid XML: <a> is never closed (line 1, column 1)'
    })
    expect(beautifyXml('</a>')).toMatchObject({
      message: expect.stringContaining('closes nothing')
    })
    expect(beautifyXml('<a x="1"')).toMatchObject({
      message: expect.stringContaining('A tag is never closed')
    })
    expect(beautifyXml('<a><!-- open</a>')).toMatchObject({
      message: expect.stringContaining('A comment is never closed')
    })
  })
})

describe('beautifierFor', () => {
  it('has one for JSON and XML only', () => {
    expect(beautifierFor('json')).toBe(beautifyJson)
    expect(beautifierFor('xml')).toBe(beautifyXml)
    expect(beautifierFor('text')).toBeNull()
    expect(beautifierFor('form')).toBeNull()
  })
})
