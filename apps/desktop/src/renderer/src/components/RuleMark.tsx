import type { RuleFinding } from '@schwabyio/gravity-core/model'
import { findingsLabel, findingText } from '../ruleFindings.js'

/**
 * A row's mark for breaking the project's rules (SPEC.md §1.4): amber, apart
 * from the red of a broken file, since nothing stops working. What each
 * finding says is on hover.
 */
export default function RuleMark({ findings }: { findings: readonly RuleFinding[] }) {
  if (findings.length === 0) return null
  return (
    <span
      className="rule-mark"
      role="img"
      aria-label={findingsLabel(findings.length)}
      title={findings.map(findingText).join('\n')}
    >
      △
    </span>
  )
}
