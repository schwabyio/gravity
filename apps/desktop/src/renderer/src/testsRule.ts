import { createContext, useContext } from 'react'
import { allowedText, type TestsAllowance } from '@schwabyio/gravity-core/model'

/**
 * The open file's `tests.only` rule (SPEC.md §1.4), for the Tests editors:
 * what a tests script may call, and the `rules.yml` that says so. Null when
 * the project has no such rule, or the file is not its own.
 */
export interface TestsRule {
  allowed: TestsAllowance[]
  source: string
}

export const TestsRuleContext = createContext<TestsRule | null>(null)

export const useTestsRule = (): TestsRule | null => useContext(TestsRuleContext)

/** What the rule allows, in words: `gta.* functions`, `gta.* and checks.*`. */
export const testsRuleText = (rule: TestsRule): string => allowedText(rule.allowed)
