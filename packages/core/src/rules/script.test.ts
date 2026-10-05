import { describe, expect, it } from 'vitest'
import { allowedText } from './model.js'
import { checksStatusCode, statusCheckFunctions, testsScriptFindings } from './script.js'

/** Each finding's line and message: where it is underlined is checked on its own. */
const gtaOnly = (code: string) =>
  testsScriptFindings(code, ['gta']).map(({ line, message }) => ({ line, message }))

describe('testsScriptFindings', () => {
  it('passes a script of gta calls given values', () => {
    expect(
      gtaOnly(`
        gta.expectResponseStatusCodeToBe(200)
        gta.expectResponseBodyToHaveProperty('user.name', 'Ada')
        gta.expectResponseBodyToHaveProperty(['jwt', 'payload', 'https://x.io/id'], /^\\d+$/)
        gta.expectResponseBodyToHaveProperty('id', 'sessionId', 'setAsCollectionVariable')
        gta.expectResponseBodyToHaveProperty('amount', -12.5)
        gta.expectResponseBodyToHaveProperty('owner', gta.get('userId'))
        gta.expectResponseBodyToHaveUnorderedArray('items', [{ id: 1, tags: ['a'] }, { id: 2 }])
        gta.expectResponseToHaveHeader('etag', \`W/"\${gta.get('version')}"\`)
        gta.set('nextId', res.body.items[0].id)
        gta.set('page', res.body?.page)
        gta.set('etag', res.header('etag'))
        gta.set('maybe', undefined)
        gta.useStrictValidation()
        await gta.skipRest('nothing more to check')
        ;
        // a comment
      `)
    ).toEqual([])
  })

  it('flags check files, gta.test, assert and any other code, each on its line', () => {
    const findings = gtaOnly(
      [
        'gta.expectResponseStatusCodeToBe(200)',
        'checks.pagination.expectPage({ size: 20 })',
        "gta.test('ids are unique', () => assert.ok(true))",
        'assert.equal(res.status, 200)',
        'const ids = res.body.map((a) => a.id)',
        'if (res.status === 200) gta.expectResponseBodyToHaveProperty("ok", true)'
      ].join('\n')
    )
    expect(findings).toEqual([
      {
        line: 2,
        message:
          'checks.pagination.expectPage({ size: 20 }): check files are not used here; tests here call only gta.* functions'
      },
      {
        line: 3,
        message:
          "gta.test('ids are unique', () => assert.ok(true)): gta.test runs a check of your own; tests here call only gta.* functions"
      },
      { line: 4, message: 'assert.equal(res.status, 200): tests here call only gta.* functions' },
      {
        line: 5,
        message: 'const ids = res.body.map((a) => a.id): tests here call only gta.* functions'
      },
      {
        line: 6,
        message:
          'if (res.status === 200) gta.expectResponseBodyToHavePropert…: an if here tests feature flags only, with gta.flag(); tests here call only gta.* functions'
      }
    ])
  })

  it('passes a RegExp built with new, and a list read back with JSON.parse', () => {
    expect(
      gtaOnly(
        [
          "gta.expectResponseStatusCodeToBe(new RegExp('^2\\d\\d$'))",
          "gta.expectResponseToHaveHeader('x-custom', new RegExp('value', 'i'))",
          "gta.expectResponseBodyToHaveUnorderedArray('roles', JSON.parse(gta.get('roles')))"
        ].join('\n')
      )
    ).toEqual([])
    expect(gtaOnly("gta.set('now', new Date().toISOString())").map((f) => f.line)).toEqual([1])
  })

  it('passes an if on feature flags around gta calls, and checks what it holds', () => {
    const code = [
      "if (gta.flag('newCheckout') === true && !gta.flag('legacy')) {",
      "  gta.expectResponseBodyToHaveProperty('version', 2)",
      "} else if (gta.flag('pricing') === 'v2') gta.expectResponseBodyToHaveProperty('version', 1)",
      'else {',
      '  console.log(res.body)',
      '}'
    ].join('\n')
    expect(gtaOnly(code)).toEqual([
      { line: 5, message: 'console.log(res.body): tests here call only gta.* functions' }
    ])
    expect(gtaOnly("if (gta.flag('a') === res.body.a) gta.useStrictValidation()")).toEqual([
      {
        line: 1,
        message:
          "if (gta.flag('a') === res.body.a) gta.useStrictValidation(): an if here tests feature flags only, with gta.flag(); tests here call only gta.* functions"
      }
    ])
  })

  it('flags an argument that is code, not a value', () => {
    const findings = gtaOnly(
      [
        "gta.expectResponseBodyToHaveProperty('count', res.body.items.map((i) => i.id).length)",
        "gta.set('ids', checks.ids.all())",
        "gta.set('n', gta.get('n') + 1)",
        "gta.set('x', (() => 1)())",
        "gta.set('y', ...list)",
        "gta.expectResponseBodyToHaveProperty('a', { [gta.get('k')]: 1, b() { return 2 } })"
      ].join('\n')
    )
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4, 5, 6])
    expect(findings[1]!.message).toBe(
      'checks.ids.all(), given to gta.set(): an argument here is a value, written out or read from res, req, params, endpoint, item or gta.get()'
    )
  })

  it('looks inside a block, and flags an optional call, ?? in a flag test and code in a read', () => {
    expect(
      gtaOnly(
        [
          '{',
          '  gta.expectResponseStatusCodeToBe(200)',
          '  assert.ok(true)',
          '}',
          'gta.expectResponseStatusCodeToBe?.(200)',
          "if (gta.flag('a') ?? true) gta.useStrictValidation()",
          "gta.set('first', res.body[pick()])",
          "gta.set('negated', !gta.get('on'))"
        ].join('\n')
      ).map((finding) => finding.line)
    ).toEqual([3, 5, 6, 7, 8])
  })

  it('does not let an alias or a computed name through', () => {
    const findings = gtaOnly(
      [
        'const c = checks',
        'c.pagination.expectPage()',
        "gta['expectResponseStatusCodeToBe'](200)",
        'globalThis.gta.uuid()'
      ].join('\n')
    )
    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3, 4])
  })

  it('allows what the list adds: gta.test with any code inside, check files, console', () => {
    const code = [
      'gta.expectResponseStatusCodeToBe(200)',
      "gta.test('ids are unique', () => { const ids = res.body.map((a) => a.id); assert.equal(new Set(ids).size, ids.length) })",
      'checks.pagination.expectPage({ size: 20 })',
      'console.log(res.body)'
    ].join('\n')
    expect(testsScriptFindings(code, ['gta', 'gta.test', 'checks', 'console'])).toEqual([])
    expect(testsScriptFindings(code, ['gta', 'checks']).map((f) => f.line)).toEqual([2, 4])
    // gta.test's name is still a value.
    expect(
      testsScriptFindings('gta.test(makeName(), () => {})', ['gta', 'gta.test']).map((f) => f.line)
    ).toEqual([1])
  })

  it('says where in the script a finding is, for an editor to underline', () => {
    const code = 'gta.expectResponseStatusCodeToBe(200)\nchecks.a.b()'
    const [finding] = testsScriptFindings(code, ['gta'])
    expect(code.slice(finding!.from, finding!.to)).toBe('checks.a.b()')
    const [argument] = testsScriptFindings("gta.set('n', foo())", ['gta'])
    expect("gta.set('n', foo())".slice(argument!.from, argument!.to)).toBe('foo()')
  })

  it('says so when a script will not parse', () => {
    expect(gtaOnly('gta.expectResponseStatusCodeToBe(200)\ngta.set(')).toEqual([
      {
        line: 2,
        message: 'will not parse, so what it calls cannot be checked: Unexpected token'
      }
    ])
  })

  it('names what the list allows', () => {
    expect(allowedText(['gta'])).toBe('gta.* functions')
    expect(allowedText(['gta', 'checks'])).toBe('gta.* and checks.*')
    expect(allowedText(['gta', 'console', 'gta.test', 'checks'])).toBe(
      'gta.*, gta.test, checks.* and console.*'
    )
  })
})

describe('the status code check', () => {
  it('finds gta.expectResponseStatusCodeToBe anywhere in a script, or a check function that calls it', () => {
    const none = new Set<string>()
    expect(checksStatusCode('gta.expectResponseStatusCodeToBe(200)', none)).toBe(true)
    expect(
      checksStatusCode("if (gta.flag('v2')) {\n  gta.expectResponseStatusCodeToBe(204)\n}", none)
    ).toBe(true)
    expect(checksStatusCode("gta.expectResponseBodyToHaveProperty('status', 200)", none)).toBe(
      false
    )
    // Named in a string or a comment, it checks nothing.
    expect(
      checksStatusCode("// gta.expectResponseStatusCodeToBe(200)\nconsole.log('x')", none)
    ).toBe(false)
    expect(checksStatusCode('checks.common.expectJson(200)', new Set(['common.expectJson']))).toBe(
      true
    )
    expect(checksStatusCode('checks.common.expectJson(200)', none)).toBe(false)
    expect(checksStatusCode('gta.expect(', none)).toBe(false)
    // Calls of things with no plain name, and literals with parts of their own, are passed by.
    expect(
      checksStatusCode(
        "handlers['x']()\nconst pattern = /^2\\d\\d$/\ngta.expectResponseStatusCodeToBe(pattern)",
        none
      )
    ).toBe(true)
  })

  it('knows which exported check functions call it', () => {
    expect(
      statusCheckFunctions([
        {
          name: 'common',
          code: [
            'export function expectJson(status) { gta.expectResponseStatusCodeToBe(status) }',
            'export async function expectSlow() { await gta.test("slow", () => {}) }',
            'export const expectError = (status, code) => {',
            '  gta.expectResponseStatusCodeToBe(status)',
            "  gta.expectResponseBodyToHaveProperty('error', code)",
            '}',
            'function helper() { gta.expectResponseStatusCodeToBe(200) }',
            'export const expectCreated = function () { gta.expectResponseStatusCodeToBe(201) }',
            'export const notAFunction = 201',
            'export { helper }'
          ].join('\n')
        },
        { name: 'broken', code: 'export function (' }
      ])
    ).toEqual(new Set(['common.expectJson', 'common.expectError', 'common.expectCreated']))
  })
})
