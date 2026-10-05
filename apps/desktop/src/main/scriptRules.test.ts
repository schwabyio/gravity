import { describe, expect, it } from 'vitest'
import { scriptRuleFindings } from './scriptRules.js'

describe('scriptRuleFindings', () => {
  it('checks a script against what the rule allows', () => {
    expect(scriptRuleFindings('checks.a.b()', ['gta'])).toEqual([
      {
        line: 1,
        from: 0,
        to: 12,
        message: 'checks.a.b(): check files are not used here; tests here call only gta.* functions'
      }
    ])
    expect(scriptRuleFindings('checks.a.b()', ['gta', 'checks'])).toEqual([])
  })

  it('checks nothing it was not given properly', () => {
    expect(scriptRuleFindings(42, ['gta'])).toEqual([])
    expect(scriptRuleFindings('checks.a.b()', 'gta')).toEqual([])
    expect(scriptRuleFindings('checks.a.b()', ['checks'])).toEqual([])
    // What the rule cannot allow is dropped, not trusted.
    expect(scriptRuleFindings('checks.a.b()', ['gta', 'everything'])).toHaveLength(1)
  })
})
