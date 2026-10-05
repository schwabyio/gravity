import path from 'node:path'
import { RULES_FILE } from '../format/constants.js'
import { readYamlMap, YamlMapError } from '../workspace/yamlMap.js'
import {
  noRules,
  RULE_NAMES,
  RULES,
  type LoadedRules,
  type RuleGroup,
  type RuleInfo,
  type RuleGuide,
  type RuleName,
  type RuleSetting
} from './model.js'

/** The key of `rules.yml` that holds its guide, beside the groups of rules. */
const GUIDE = 'guide'

/**
 * A project's `rules.yml` (SPEC.md §1.4): how its files are laid out and
 * written, so the people and agents working on it keep it consistent.
 *
 * A global project's `rules.yml` lies under the project's, rule by rule, always:
 * a project changes a shared rule by setting it, and turns it off with `null`
 * or `optional`. Breaking a rule never stops a run; `gta lint` reports it.
 */
export { RULES_FILE }

/** Why the rules cannot be read: a file that will not parse, or a rule that is not one. */
export class RulesError extends Error {
  override name = 'RulesError'
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The rules of the project at `root`: its global project's `rules.yml`, then
 * its own over it, rule by rule. Neither file is required. Throws `RulesError`
 * listing every rule that is not valid, each with the file it is in.
 */
export async function loadRules(
  root: string,
  global: { root: string; uses: string } | null
): Promise<LoadedRules> {
  const layers: Array<{ label: string; file: string }> = [
    ...(global
      ? [
          {
            label: path.posix.join(global.uses, RULES_FILE),
            file: path.join(global.root, RULES_FILE)
          }
        ]
      : []),
    { label: RULES_FILE, file: path.join(root, RULES_FILE) }
  ]

  const merged = new Map<RuleName, { value: unknown; source: string }>()
  const files: string[] = []
  const guides: RuleGuide[] = []
  const problems: string[] = []
  for (const { label, file } of layers) {
    let map: Record<string, unknown> | null
    try {
      map = await readYamlMap(file, label, 'ids: { collections: kebab-case }')
    } catch (cause) {
      if (cause instanceof YamlMapError) throw new RulesError(cause.message)
      throw cause
    }
    if (map === null) continue
    files.push(label)
    for (const [group, rules] of Object.entries(map)) {
      // Prose, not a rule: every file's is read, the global project's first.
      if (group === GUIDE) {
        if (typeof rules === 'string') {
          if (rules.trim() !== '') guides.push({ source: label, text: rules })
        } else if (rules !== null) {
          problems.push(`${GUIDE} (${label}): Markdown, written as a block: guide: |`)
        }
        continue
      }
      if (!Object.hasOwn(RULES, group)) {
        problems.push(
          `${group} (${label}): not a group of rules; they are ${Object.keys(RULES).join(', ')}, and ${GUIDE}`
        )
        continue
      }
      const known = RULES[group as RuleGroup] as Record<string, RuleInfo>
      if (rules === null) {
        // The whole group off: every rule of it a file under this one set.
        for (const key of Object.keys(known)) {
          const rule = `${group}.${key}` as RuleName
          if (merged.has(rule)) merged.set(rule, { value: null, source: label })
        }
        continue
      }
      if (!isMap(rules)) {
        problems.push(
          `${group} (${label}): a map of rules, such as ${group}: { ${Object.keys(known)[0]}: … }, or null`
        )
        continue
      }
      for (const [key, value] of Object.entries(rules)) {
        const rule = `${group}.${key}` as RuleName
        if (!Object.hasOwn(known, key)) {
          problems.push(
            `${rule} (${label}): not a rule; ${group} has ${Object.keys(known).join(', ')}`
          )
          continue
        }
        if (value !== null) {
          const result = known[key]!.schema.safeParse(value)
          if (!result.success) {
            problems.push(`${rule} (${label}): ${result.error.issues[0]?.message ?? 'not valid'}`)
            continue
          }
        }
        merged.set(rule, { value, source: label })
      }
    }
  }
  if (problems.length > 0) {
    throw new RulesError(
      `Rules are not valid (SPEC.md §1.4):\n${problems.map((line) => `  ${line}`).join('\n')}`
    )
  }

  const rules = noRules()
  const settings: RuleSetting[] = []
  for (const rule of RULE_NAMES) {
    const set = merged.get(rule)
    if (!set) continue
    const on = set.value !== null && set.value !== 'optional'
    settings.push({ rule, value: set.value, source: set.source, on })
    if (!on) continue
    const [group, key] = rule.split('.') as [RuleGroup, string]
    ;(rules[group] as Record<string, unknown>)[key] = set.value
  }
  return { rules, settings, files, guides }
}
