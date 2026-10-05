import path from 'node:path'
import {
  COLLECTIONS_DIR,
  lintProject,
  loadRules,
  PROJECT_FILE,
  readProject,
  RULES_FILE,
  ruleDoc,
  type LintResult,
  type LoadedRules,
  type RuleFinding
} from '@schwabyio/gravity-core'
import { JSON_FORMAT_VERSION } from './json.js'
import { isDirectory, ProjectError } from './project.js'
import { field, type Paint } from './report.js'

/**
 * `gta lint` and `gta rules`: a project's rules (SPEC.md §1.4), checked and
 * listed. Neither runs anything, nor needs `settings.yml`, so both work in a
 * global project's folder too.
 */

interface Output {
  out: (line: string) => void
  /** `--json`: the one document stdout carries instead of the text. */
  emit: ((value: unknown) => void) | null
  p: Paint
}

interface RulesProject {
  root: string
  name: string
  /** As `project.yml` names it, when it uses one. */
  uses: string | null
  /** The global project's folder: what the project's steps inherit from it is linted with them. */
  global: { root: string } | null
  loaded: LoadedRules
}

/** The project in `root` and its rules: its global project's `rules.yml`, its own over it. */
async function openRules(root: string): Promise<RulesProject> {
  const info = await readProject(root)
  if (info.source === null && !(await isDirectory(path.join(root, COLLECTIONS_DIR)))) {
    throw new ProjectError(
      `There is no ${COLLECTIONS_DIR}/ or ${PROJECT_FILE} in ${root}.\n` +
        `gta lint and gta rules run from a project folder, or a global project's.`
    )
  }
  // Without its global project, the rules it shares would quietly not be checked.
  if (info.problems.length > 0) {
    throw new ProjectError(
      `${PROJECT_FILE} must be fixed first, to know which rules apply:\n` +
        info.problems.map((problem) => `  ${problem.message}`).join('\n')
    )
  }
  return {
    root,
    name: info.doc?.name ?? path.basename(root),
    uses: info.global?.uses ?? null,
    global: info.global ? { root: info.global.root } : null,
    loaded: await loadRules(root, info.global)
  }
}

/** `Rules from: ../shared/rules.yml, rules.yml`, or why there are none. */
function rulesLine(project: RulesProject, p: Paint): string {
  if (project.loaded.files.length > 0) return field('Rules from', project.loaded.files.join(', '))
  const where = project.uses
    ? `no ${RULES_FILE} here or in ${project.uses}`
    : `no ${RULES_FILE} here`
  return field('Rules', p.dim(`none: ${where}`))
}

const shownValue = (value: unknown): string =>
  value === null ? 'off' : Array.isArray(value) ? `[${value.join(', ')}]` : String(value)

/** `gta rules`: each rule set, its value, the file it came from and what it means. */
export async function rulesCommand(root: string, { out, emit, p }: Output): Promise<void> {
  const project = await openRules(root)
  const { settings } = project.loaded
  if (emit) {
    emit({
      formatVersion: JSON_FORMAT_VERSION,
      project: { name: project.name, root: project.root },
      files: project.loaded.files,
      rules: settings.map((setting) => ({ ...setting, doc: ruleDoc(setting.rule) })),
      guides: project.loaded.guides
    })
    return
  }

  out(field('Project', `${project.name} ${p.dim(project.root)}`))
  out(rulesLine(project, p))
  if (settings.length > 0) {
    out('')
    const ruleWidth = Math.max(...settings.map((s) => s.rule.length))
    const valueWidth = Math.max(...settings.map((s) => shownValue(s.value).length))
    for (const setting of settings) {
      const value = shownValue(setting.value).padEnd(valueWidth)
      out(
        `${p.bold(setting.rule.padEnd(ruleWidth))}  ${setting.on ? value : p.dim(value)}  ${p.dim(setting.source)}`
      )
      out(`    ${ruleDoc(setting.rule)}`)
    }
  }
  // What no rule can check, as the project wrote it, for people and agents to read.
  for (const guide of project.loaded.guides) {
    out('')
    out(`${p.bold('Guide')} ${p.dim(`(${guide.source})`)}`)
    for (const line of guide.text.trimEnd().split('\n')) out(line === '' ? '' : `  ${line}`)
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** `14 collections, 3 reusable requests files, 1 base collection, 2 endpoints files`. */
function checkedLine(checked: LintResult['checked']): string {
  return [
    plural(checked.collections, 'collection', 'collections'),
    plural(checked.requests, 'reusable requests file', 'reusable requests files'),
    plural(checked.bases, 'base collection', 'base collections'),
    plural(checked.endpoints, 'endpoints file', 'endpoints files')
  ].join(', ')
}

/** `collections/a.yml:12  message  [rule from source]`. */
function findingLine(finding: RuleFinding, p: Paint): string {
  const place = finding.line === null ? finding.file : `${finding.file}:${finding.line}`
  if (finding.rule === null) return `${place}  ${p.red(finding.message)}`
  return `${place}  ${finding.message}  ${p.dim(`[${finding.rule} from ${finding.source}]`)}`
}

/**
 * `gta lint`: every file of the project checked against its rules. Returns
 * whether anything was found, which fails the command.
 */
export async function lintCommand(root: string, { out, emit, p }: Output): Promise<boolean> {
  const project = await openRules(root)
  const { loaded } = project
  const result: LintResult = loaded.settings.some((setting) => setting.on)
    ? await lintProject(root, loaded, project.global)
    : { findings: [], checked: { collections: 0, requests: 0, bases: 0, endpoints: 0 } }
  const found = result.findings.length > 0

  if (emit) {
    emit({
      formatVersion: JSON_FORMAT_VERSION,
      project: { name: project.name, root: project.root },
      files: loaded.files,
      rules: loaded.rules,
      checked: result.checked,
      findings: result.findings
    })
    return found
  }

  out(field('Project', `${project.name} ${p.dim(project.root)}`))
  out(rulesLine(project, p))
  const inEffect = loaded.settings.filter((setting) => setting.on).length
  if (inEffect === 0) {
    out(p.dim('Nothing to check.'))
    return false
  }
  out(field('In effect', `${plural(inEffect, 'rule', 'rules')} ${p.dim('(gta rules lists them)')}`))
  out(field('Checked', checkedLine(result.checked)))
  out('')
  for (const finding of result.findings) out(findingLine(finding, p))
  if (found) {
    const files = new Set(result.findings.map((finding) => finding.file)).size
    out('')
    out(
      p.red(
        `${plural(result.findings.length, 'finding', 'findings')} in ${plural(files, 'file', 'files')}`
      )
    )
  } else {
    out(p.green('No findings: every file follows the rules.'))
  }
  return found
}
