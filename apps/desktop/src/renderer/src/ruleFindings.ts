import type { RuleFinding, StepList } from '@schwabyio/gravity-core/model'

/**
 * A project's rule findings (SPEC.md §1.4), sorted out for the rows and views
 * that mark them. Pure, so the marks and their tests agree.
 */

/** A file as findings name it, from the project folder: `collections/payments/refunds.yml`. */
export function projectFile(projectPath: string, file: string): string | null {
  const root = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const target = file.replace(/\\/g, '/')
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : null
}

/** The findings about one file — or one folder, `collections/payments/` — steps and all. */
export const findingsOf = (findings: readonly RuleFinding[], file: string | null): RuleFinding[] =>
  file === null ? [] : findings.filter((finding) => finding.file === file)

/** Those about a file as a whole: its id, folder, docs, tags or its own tests. */
export const fileFindings = (findings: readonly RuleFinding[]): RuleFinding[] =>
  findings.filter((finding) => finding.step === null)

/** Those about each step of one list, by the step's index. */
export function stepFindings(
  findings: readonly RuleFinding[],
  list: StepList
): Record<number, RuleFinding[]> {
  const byIndex: Record<number, RuleFinding[]> = {}
  for (const finding of findings) {
    if (finding.step?.list !== list) continue
    ;(byIndex[finding.step.index] ??= []).push(finding)
  }
  return byIndex
}

/** A finding as read on hover: what is wrong, and whose rule it is. */
export const findingText = (finding: RuleFinding): string =>
  finding.rule ? `${finding.message} (${finding.rule} in ${finding.source})` : finding.message

/** `1 rule finding`, `3 rule findings`. */
export const findingsLabel = (count: number): string =>
  `${count} rule finding${count === 1 ? '' : 's'}`
