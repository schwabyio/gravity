import { describe, expect, it } from 'vitest'
import { testsRuleText } from './testsRule.js'

describe('testsRuleText', () => {
  it('says what a tests.only rule allows, as the Tests hint words it', () => {
    expect(testsRuleText({ allowed: ['gta'], source: 'rules.yml' })).toBe('gta.* functions')
    expect(testsRuleText({ allowed: ['gta', 'console'], source: 'rules.yml' })).toBe(
      'gta.* and console.*'
    )
  })
})
