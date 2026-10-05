import type { RuleFinding } from '@schwabyio/gravity-core/model'
import { describe, expect, it } from 'vitest'
import {
  fileFindings,
  findingsLabel,
  findingsOf,
  findingText,
  projectFile,
  stepFindings
} from './ruleFindings.js'

const finding = (file: string, step: RuleFinding['step'] = null): RuleFinding => ({
  file,
  line: 1,
  rule: 'docs.steps',
  source: '../shared/rules.yml',
  step,
  message: 'no docs'
})

describe('rule findings', () => {
  it('names a file from the project folder, on any platform', () => {
    expect(projectFile('/w/shop', '/w/shop/collections/a.yml')).toBe('collections/a.yml')
    expect(projectFile('C:\\w\\shop\\', 'C:\\w\\shop\\collections\\pay\\a.yml')).toBe(
      'collections/pay/a.yml'
    )
    expect(projectFile('/w/shop', '/w/shopping/collections/a.yml')).toBeNull()
  })

  it('sorts findings by file, then by the file as a whole or each step', () => {
    const all = [
      finding('collections/a.yml'),
      finding('collections/a.yml', { list: 'steps', index: 2 }),
      finding('collections/a.yml', { list: 'setup', index: 0 }),
      finding('collections/a.yml', { list: 'steps', index: 2 }),
      finding('collections/b.yml')
    ]
    const ofA = findingsOf(all, 'collections/a.yml')
    expect(ofA).toHaveLength(4)
    expect(fileFindings(ofA)).toHaveLength(1)
    expect(Object.keys(stepFindings(ofA, 'steps'))).toEqual(['2'])
    expect(stepFindings(ofA, 'steps')[2]).toHaveLength(2)
    expect(stepFindings(ofA, 'setup')[0]).toHaveLength(1)
    expect(findingsOf(all, null)).toEqual([])
  })

  it('says each finding with its rule and file', () => {
    expect(findingText(finding('collections/a.yml'))).toBe(
      'no docs (docs.steps in ../shared/rules.yml)'
    )
    expect(
      findingText({ ...finding('collections/a.yml'), rule: null, message: 'will not parse' })
    ).toBe('will not parse')
    expect(findingsLabel(1)).toBe('1 rule finding')
    expect(findingsLabel(3)).toBe('3 rule findings')
  })
})
