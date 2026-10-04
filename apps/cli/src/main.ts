import fs from 'node:fs/promises'
import path from 'node:path'
import {
  COLLECTIONS_DIR,
  canonical,
  isInside,
  samePath,
  referenceProblems,
  type FlagResolution
} from '@schwabyio/gravity-core'
import { parseArgs, UsageError } from './args.js'
import { loadProject, ProjectError, type OpenProject } from './project.js'
import { runPool, type Runner } from './pool.js'
import {
  failureDetails,
  field,
  nameCell,
  nameWidthFor,
  paint,
  rule,
  summary,
  tableHeader,
  tableRow,
  tableWidth,
  tally,
  totalsOf,
  type CollectionTally,
  type Paint
} from './report.js'
import { flagList, htmlReport, SUMMARY_PAGE, type HtmlCollection, type HtmlRun } from './html.js'
import { junitReport } from './junit.js'
import { jsonError, jsonListing, jsonReport, type ReportPaths } from './json.js'
import {
  idOf,
  selectCollections,
  stepCountOf,
  type ListingProblem,
  type Request,
  type RunTarget,
  type Selection
} from './select.js'
import {
  DEFAULT_SETTINGS,
  DEFAULT_SOURCE,
  envNameOf,
  SETTING_KEYS,
  SettingsError,
  type SettingKey,
  type Settings
} from './settings.js'

declare const __GTA_VERSION__: string | undefined
/** Set by the bundle; running from source, there is none. */
export const VERSION = typeof __GTA_VERSION__ === 'string' ? __GTA_VERSION__ : '0.0.0-dev'

/** The JUnit report's folder in `testResultsBasePath`, and its file in there. */
export const JUNIT_DIR = 'junit'
export const JUNIT_FILE = 'junit.xml'
/** The HTML report's folder in `testResultsBasePath`: `summary.html` and a page per collection. */
export const HTML_DIR = 'html'
/** The JSON report's folder in `testResultsBasePath`, and its file in there. */
export const JSON_DIR = 'json'
export const JSON_FILE = 'results.json'

/** Exit codes: tests passed, tests failed, or gta could not run them at all. */
export const EXIT = { passed: 0, failed: 1, unusable: 2 } as const

export interface CliContext {
  cwd: string
  env: Record<string, string | undefined>
  out: (line: string) => void
  err: (line: string) => void
  color: boolean
  /** How collections run: worker threads from the bin, in process in tests. */
  runner: (settings: Settings) => Runner
  /** Open a written report in the browser, for `autoOpenTestResultHtml`. */
  open: (file: string) => void
}

export async function main(argv: readonly string[], cli: CliContext): Promise<number> {
  let ctx = cli
  let p = paint(ctx.color)
  /** With `--json`, stdout carries one JSON document and nothing else. */
  let emit: ((value: unknown) => void) | null = null
  try {
    const args = parseArgs(argv)
    if (args.json && !args.help && !args.version && args.command !== null) {
      emit = (value) => cli.out(JSON.stringify(value, null, 2))
      ctx = { ...cli, out: () => {}, color: false }
      p = paint(false)
    }
    if (args.version) {
      ctx.out(VERSION)
      return EXIT.passed
    }
    if (args.help || args.command === null || args.command === 'help') {
      ctx.out(usage(p))
      return EXIT.passed
    }

    const project = await openProject(ctx, args.overrides, args.flags)
    for (const warning of project.warnings) ctx.err(p.yellow(`warning: ${warning}`))

    const command = args.command
    if (command === 'g' || command === 'get') {
      const selection = selectFor(project, { kind: 'all' })
      const problems = await listingProblems(project, selection)
      // Something a run would stop at fails the listing, so CI can check a project with it.
      const code =
        problems.length > 0 || selection.targets.some((target) => target.broken)
          ? EXIT.failed
          : EXIT.passed
      if (emit) {
        emit(
          jsonListing({
            project: { name: project.name, root: project.root },
            environments: project.environments,
            environmentType: project.settings.environmentType,
            settings: { values: project.settings, sources: project.settingSources },
            flags: project.flags,
            tags: project.settings.tags,
            notTags: project.settings.notTags,
            targets: selection.targets,
            excluded: selection.excluded,
            untagged: selection.untagged,
            problems
          })
        )
        return code
      }
      list(project, selection, problems, ctx, p)
      return code
    }
    const request: Request =
      command === 'a' || command === 'all'
        ? { kind: 'all' }
        : { kind: 'list', selectors: command.split(',').filter((s) => s.trim() !== '') }
    return await run(project, selectFor(project, request), ctx, p, emit)
  } catch (cause) {
    if (
      cause instanceof UsageError ||
      cause instanceof SettingsError ||
      cause instanceof ProjectError
    ) {
      ctx.err(p.red(cause.message))
      // Asked for JSON but the words would not parse: still JSON, so a tool reading it copes.
      const json =
        emit ??
        (argv.includes('--json') ? (v: unknown) => cli.out(JSON.stringify(v, null, 2)) : null)
      json?.(jsonError(cause.message, EXIT.unusable))
      return EXIT.unusable
    }
    throw cause
  }
}

/** The project `gta` was run in, its settings, and everything in `collections/`. */
const openProject = async (
  ctx: CliContext,
  overrides: Record<string, string | true>,
  flagArgs: readonly string[] = []
): Promise<OpenProject> =>
  loadProject({ root: await canonical(ctx.cwd), env: ctx.env, overrides, flagArgs })

const selectFor = (project: OpenProject, request: Request): Selection =>
  selectCollections(project.collections, request, {
    tags: project.settings.tags,
    notTags: project.settings.notTags
  })

/**
 * What `gta get` finds wrong beyond the collections it lists as broken: a
 * `use:`, `extends:` or body file a run would stop at, and a collection it leaves out that
 * would not load. Every collection is checked, those `gta all` leaves out too,
 * which would otherwise go unnoticed until one is run by name.
 */
async function listingProblems(
  project: OpenProject,
  selection: Selection
): Promise<ListingProblem[]> {
  const listed = new Set(selection.targets.map((target) => target.id))
  const problems: ListingProblem[] = []
  for (const collection of project.collections) {
    const id = idOf(collection)
    const leftOut = listed.has(id) ? null : collection.doc.exclude === true ? 'excluded' : 'tags'
    if (collection.problems.length > 0) {
      // A listed one is already shown as broken.
      const message = collection.problems.map((problem) => problem.message).join('; ')
      if (leftOut) problems.push({ id, leftOut, step: null, message })
      continue
    }
    for (const problem of await referenceProblems(collection.doc, collection.path)) {
      problems.push({ id, leftOut, ...problem })
    }
  }
  return problems
}

/** `gta get`: what `gta all` would run, without running it. */
function list(
  project: OpenProject,
  selection: Selection,
  problems: readonly ListingProblem[],
  ctx: CliContext,
  p: Paint
): void {
  const { settings } = project

  ctx.out(field('Project', `${project.name} ${p.dim(project.root)}`))
  ctx.out(
    field(
      'Environments',
      project.environments.length > 0
        ? project.environments
            .map((name) => (name === settings.environmentType ? p.bold(`${name} ◀`) : name))
            .join(', ')
        : p.dim('none')
    )
  )
  ctx.out(field('Flags', flagLine(project.flags, p)))
  if (project.caFiles.length > 0) ctx.out(field('CA files', project.caFiles.join(', ')))
  for (const line of settingLines(project, p)) ctx.out(line)
  ctx.out('')

  const width = nameWidthFor(selection.targets.map((t) => t.id))
  // The folder only here, where it helps pick a group; a run names collections by id alone.
  const dirWidth = Math.max(
    'Folder'.length,
    ...selection.targets.map((t) => (t.collection.directory ?? '').length)
  )
  ctx.out(
    p.bold(
      `${'#'.padStart(4)}  ${'Collection'.padEnd(width)} ${'Steps'.padStart(7)} ${'Rows'.padStart(5)}  ${'Folder'.padEnd(dirWidth)}  Tags`
    )
  )
  selection.targets.forEach((target, i) => {
    const { doc } = target.collection
    const count = target.broken
      ? 'broken'
      : target.steps
        ? `${target.steps.length}/${doc.steps.length}`
        : String(doc.steps.length)
    const steps = target.broken ? p.red(count.padStart(7)) : count.padStart(7)
    const tags = [...new Set([...(doc.tags ?? []), ...doc.steps.flatMap((s) => s.tags ?? [])])]
    // Data file rows: the collection runs once per row.
    const rows = target.collection.dataFile ? String(target.collection.dataFile.rows) : ''
    ctx.out(
      `${String(i + 1).padStart(4)}  ${nameCell(target.id, width)} ${steps} ${rows.padStart(5)}  ${(target.collection.directory ?? '').padEnd(dirWidth)}  ${p.dim(tags.join(', '))}`
    )
  })
  ctx.out('')

  for (const target of selection.targets.filter((t) => t.broken)) {
    ctx.out(`${p.red('broken')} ${target.id}: ${target.broken}`)
  }
  const leftOut = { excluded: ' (excluded)', tags: ' (left out by tags)' }
  for (const problem of problems) {
    const step =
      problem.step === null
        ? ''
        : `, ${problem.stage ? `${problem.stage} ` : ''}step ${problem.step + 1}`
    const where = `${problem.id}${problem.leftOut ? leftOut[problem.leftOut] : ''}${step}`
    ctx.out(`${p.red('broken')} ${where}: ${problem.message}`)
  }
  if (selection.excluded.length > 0) {
    ctx.out(field('Excluded', `${selection.excluded.join(', ')} ${p.dim('(exclude: true)')}`))
  }
  if (selection.untagged > 0) {
    ctx.out(field('By tags', `${selection.untagged} collection(s) left out by tags`))
  }
  const steps = selection.targets.reduce((n, t) => n + stepCountOf(t), 0)
  ctx.out(field('Total', `${selection.targets.length} collections, ${steps} steps`))
}

/**
 * `gta get`'s settings: each one something set, and where it came from — the
 * global project's `settings.yml` (SPEC.md §1.3), the project's, `GTA_*` or a flag.
 */
function settingLines(project: OpenProject, p: Paint): string[] {
  const rows = (Object.keys(SETTING_KEYS) as SettingKey[])
    .filter((key) => project.settingSources[key] !== DEFAULT_SOURCE)
    .map((key) => ({
      cell: `${key}: ${shownSetting(project.settings[key])}`,
      source: project.settingSources[key]
    }))
  if (rows.length === 0) return [field('Settings', p.dim('all defaults'))]
  const width = Math.max(...rows.map((row) => row.cell.length))
  const indent = ' '.repeat(field('Settings', '').length)
  return rows.map(
    (row, i) =>
      `${i === 0 ? field('Settings', '') : indent}${row.cell.padEnd(width)}  ${p.dim(row.source)}`
  )
}

const shownSetting = (value: Settings[SettingKey]): string =>
  Array.isArray(value) ? (value.length > 0 ? value.join(', ') : '[]') : String(value ?? 'none')

/** Run the selection at `limitConcurrency`, reporting each collection as it finishes. */
async function run(
  project: OpenProject,
  selection: Selection,
  ctx: CliContext,
  p: Paint,
  /** `--json`: where the results go, as one JSON document, instead of the table. */
  emit: ((value: unknown) => void) | null = null
): Promise<number> {
  const { settings } = project
  const width = nameWidthFor(selection.targets.map((t) => t.id))
  const line = rule(p, tableWidth(width))

  ctx.out(line)
  ctx.out(p.bold(`gta ${VERSION}`))
  ctx.out(line)
  ctx.out(field('Project', `${project.name} ${p.dim(project.root)}`))
  ctx.out(field('Environment', settings.environmentType ?? p.dim('none')))
  ctx.out(field('Concurrency', String(settings.limitConcurrency)))
  ctx.out(field('Flags', flagLine(project.flags, p)))
  ctx.out(field('Timeout', `${settings.timeoutCollection} ms per collection`))
  if (project.caFiles.length > 0) ctx.out(field('CA files', project.caFiles.join(', ')))
  if (settings.tags.length > 0) ctx.out(field('Tags', settings.tags.join(', ')))
  if (settings.notTags.length > 0) ctx.out(field('Not tags', settings.notTags.join(', ')))
  if (settings.bail) ctx.out(field('Bail', 'on: a collection stops at its first failing step'))
  const reportNames = [
    settings.generateJUnitResults ? `${JUNIT_DIR}/${JUNIT_FILE}` : '',
    settings.generateJsonResults ? `${JSON_DIR}/${JSON_FILE}` : '',
    wantsHtml(settings) ? `${HTML_DIR}/${SUMMARY_PAGE}` : ''
  ].filter(Boolean)
  if (reportNames.length > 0) {
    ctx.out(
      field('Reports', reportNames.map((n) => `${settings.testResultsBasePath}/${n}`).join(', '))
    )
  }
  const leftOut = [
    selection.excluded.length > 0 ? `${selection.excluded.length} excluded` : '',
    selection.untagged > 0 ? `${selection.untagged} left out by tags` : ''
  ].filter(Boolean)
  ctx.out(
    field(
      'Collections',
      `${selection.targets.length} to run${leftOut.length > 0 ? p.dim(` (${leftOut.join(', ')})`) : ''}`
    )
  )
  ctx.out(line)

  if (selection.targets.length === 0) {
    ctx.err(p.red('Nothing to run: no collection matched.'))
    emit?.(jsonError('Nothing to run: no collection matched.', EXIT.failed))
    return EXIT.failed
  }

  ctx.out(tableHeader(width, p))

  // `build\gta` written on Windows means the same folder on macOS and Linux.
  const base = settings.testResultsBasePath
  const reportsDir = path.isAbsolute(base)
    ? path.resolve(base)
    : path.resolve(project.root, ...base.split(/[\\/]+/))
  const htmlDir = path.join(reportsDir, HTML_DIR)
  // Deleted before every run, not after: whatever is in it afterwards is from this
  // run, even one that dies part way or writes no reports.
  const problem = await clearResults(reportsDir, project.root)
  if (problem) {
    ctx.err(p.red(problem))
    emit?.(jsonError(problem, EXIT.unusable))
    return EXIT.unusable
  }

  const runner = ctx.runner(settings)
  const tallies: CollectionTally[] = []
  const finished = new Map<RunTarget, HtmlCollection>()
  const startedAt = Date.now()
  const started = performance.now()
  await runPool(selection.targets, settings.limitConcurrency, async (target) => {
    const collectionStartedAt = Date.now()
    const collectionStarted = performance.now()
    const outcome = target.broken
      ? { ok: false as const, message: target.broken }
      : await runner({
          file: target.collection.path,
          projectRoot: project.root,
          environment: settings.environmentType,
          steps: target.steps,
          bail: settings.bail,
          flags: project.flags.values
        })
    const collectionMs = performance.now() - collectionStarted
    const result = tally(target, outcome, collectionMs)
    finished.set(target, {
      id: target.id,
      file: `${COLLECTIONS_DIR}/${target.collection.relativePath}`,
      outcome,
      startedAt: collectionStartedAt,
      durationMs: collectionMs,
      tally: result,
      docs: target.collection.doc.docs
    })
    tallies.push(result)
    ctx.out(tableRow(tallies.length, result, width, p))
  })
  const durationMs = performance.now() - started

  ctx.out(line)
  const details = failureDetails(tallies, p)
  if (details.length > 0) {
    ctx.out(p.bold('Failures'))
    ctx.out('')
    for (const detail of details) ctx.out(detail)
    ctx.out(line)
  }
  const totals = totalsOf(tallies)
  for (const total of summary(totals, durationMs, p)) ctx.out(total)

  const run: HtmlRun = {
    flags: project.flags.values,
    flagSources: project.flags.sources,
    flagCommand: project.flags.command?.command ?? null,
    project: project.name,
    root: project.root,
    version: VERSION,
    environment: settings.environmentType,
    concurrency: settings.limitConcurrency,
    timeoutCollection: settings.timeoutCollection,
    tags: settings.tags,
    notTags: settings.notTags,
    bail: settings.bail,
    excluded: selection.excluded,
    untagged: selection.untagged,
    startedAt,
    durationMs,
    // In the order selected, whichever finished first, so two reports compare.
    collections: selection.targets.flatMap((target) => finished.get(target) ?? [])
  }
  /** Each report is the file shown for it, and the files it writes, relative to it. */
  const reports: Array<{
    label: string
    dir: string
    shown: string
    files: () => Array<{ path: string; text: string }>
  }> = []
  if (settings.generateJUnitResults) {
    reports.push({
      label: 'JUnit',
      dir: path.join(reportsDir, JUNIT_DIR),
      shown: JUNIT_FILE,
      files: () => [{ path: JUNIT_FILE, text: junitReport(run) }]
    })
  }
  // Where each report goes, for the JSON to say — before any is written, so the
  // JSON file can name itself.
  const paths: ReportPaths = {
    ...(settings.generateJUnitResults
      ? { junit: path.join(reportsDir, JUNIT_DIR, JUNIT_FILE) }
      : {}),
    ...(wantsHtml(settings) ? { html: path.join(htmlDir, SUMMARY_PAGE) } : {}),
    ...(settings.generateJsonResults ? { json: path.join(reportsDir, JSON_DIR, JSON_FILE) } : {})
  }
  if (settings.generateJsonResults) {
    reports.push({
      label: 'JSON',
      dir: path.join(reportsDir, JSON_DIR),
      shown: JSON_FILE,
      files: () => [
        { path: JSON_FILE, text: `${JSON.stringify(jsonReport(run, paths), null, 2)}\n` }
      ]
    })
  }
  if (wantsHtml(settings)) {
    reports.push({
      label: 'HTML',
      dir: htmlDir,
      shown: SUMMARY_PAGE,
      files: () => htmlReport(run).map((page) => ({ path: page.path, text: page.html }))
    })
  }
  let reportFailed = false
  for (const report of reports) {
    const shown = path.join(report.dir, report.shown)
    try {
      for (const file of report.files()) {
        const target = path.join(report.dir, ...file.path.split('/'))
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, file.text)
      }
      ctx.out(field(report.label, shown))
      if (report.label === 'HTML' && settings.autoOpenTestResultHtml) ctx.open(shown)
    } catch (cause) {
      // CI reads a report to decide, so one that is missing fails the run.
      ctx.err(
        p.red(`Could not write the ${report.label} report to ${shown}: ${(cause as Error).message}`)
      )
      reportFailed = true
    }
  }
  ctx.out(line)
  // The same document the file holds; stdout gets it whether or not the file was asked for.
  emit?.(jsonReport(run, paths))
  if (reportFailed) return EXIT.unusable
  return totals.collections.failed === 0 ? EXIT.passed : EXIT.failed
}

export function usage(p: Paint): string {
  const settings = (Object.keys(SETTING_KEYS) as SettingKey[]).flatMap((key) => {
    const fallback = DEFAULT_SETTINGS[key]
    const shown = Array.isArray(fallback)
      ? fallback.length > 0
        ? fallback.join(',')
        : 'none'
      : String(fallback ?? 'none')
    return [
      `    ${p.bold(`--${key}`)} ${p.dim(`(default ${shown}; ${envNameOf(key)})`)}`,
      `        ${SETTING_KEYS[key].doc}`
    ]
  })
  return [
    `${p.bold('gta')} ${VERSION} — Gravity Test Automation`,
    '',
    `  ${p.bold('Usage:')} gta <command> [--settingsKey value]...`,
    '',
    '  Run from a project folder: the one holding collections/ and settings.yml.',
    '',
    `  ${p.bold('Commands:')}`,
    '    g, get          List the collections `gta all` would run, without running them.',
    '                    Exits 1 on a broken collection, or a use:, extends: or body',
    '                    file that would stop a run, in any collection.',
    '    a, all          Run every collection, less those with exclude: true.',
    '    <list>          Run the collections and folders named, comma separated,',
    '                    in that order: smoke,checkout/sessions,payments',
    '                    A folder leaves out its excluded collections;',
    '                    one named on its own runs.',
    '                    A collection called all or get: give it as all.yml.',
    '',
    `  ${p.bold('Options:')}`,
    '    --json          Print the results as JSON on stdout instead of the table; with',
    '                    get, the collections it would run. Errors are JSON too.',
    '    --flag name=value',
    '                    Override a feature flag for this run; any number of them.',
    '                    GTA_FLAG_<name>=value does the same from the environment.',
    '',
    `  ${p.bold('Settings')} (the global project's settings.yml, then this project's, then`,
    '  GTA_* environment variables, then --flags; gta get shows where each came from):',
    ...settings,
    '',
    `  ${p.bold('Exit code:')} 0 passed, 1 failed, 2 could not run (or write a report).`
  ].join('\n')
}

const wantsHtml = (settings: Settings) =>
  settings.generateHtmlResults || settings.autoOpenTestResultHtml

/**
 * What gta writes in `testResultsBasePath` — a folder per report, and what each
 * holds — and so all it will delete from there.
 */
const RESULT_DIRS: Record<string, (name: string) => boolean> = {
  [JUNIT_DIR]: (name) => name === JUNIT_FILE,
  [HTML_DIR]: (name) => name.endsWith('.html'),
  [JSON_DIR]: (name) => name === JSON_FILE
}
/** What an operating system leaves in any folder it has shown. */
const SYSTEM_FILES = new Set(['.DS_Store', 'Thumbs.db'])

/**
 * Delete the test results folder before a run, so everything in it afterwards
 * is from this run.
 *
 * `testResultsBasePath` can point anywhere, so only a folder holding nothing
 * but what gta writes — `junit/junit.xml`, `html/` of pages — is deleted, and never the
 * project or a folder holding it. Anything else there stops the run instead:
 * a report is never worth someone's files. Returns why not, or null when the
 * folder is gone.
 */
async function clearResults(dir: string, projectRoot: string): Promise<string | null> {
  if (samePath(dir, projectRoot) || isInside(dir, projectRoot)) {
    return `testResultsBasePath is ${dir}, which holds the project: gta deletes its test results folder before each run, so point it at a folder of its own.`
  }
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return null
  }
  const others = entries.filter((entry) => !(entry in RESULT_DIRS) && !SYSTEM_FILES.has(entry))
  // Each report's folder holds that report only: anything else in it is someone's.
  for (const [folder, ours] of Object.entries(RESULT_DIRS)) {
    if (!entries.includes(folder)) continue
    const inside = await fs.readdir(path.join(dir, folder)).catch(() => [] as string[])
    others.push(
      ...inside
        .filter((name) => !ours(name) && !SYSTEM_FILES.has(name))
        .map((name) => `${folder}/${name}`)
    )
  }
  if (others.length > 0) {
    return (
      `${dir} holds files gta did not write (${others.slice(0, 5).join(', ')}${others.length > 5 ? ', …' : ''}), ` +
      `so it will not delete it before the run. Point testResultsBasePath somewhere else, or remove them.`
    )
  }
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return null
  } catch (cause) {
    return `Could not delete ${dir} before the run: ${(cause as Error).message}`
  }
}

/** `newCheckout=true, pricing=v2 (from node scripts/flags.mjs; 1 overridden)`. */
function flagLine(flags: FlagResolution, p: Paint): string {
  const list = flagList(flags.values)
  const overridden = Object.values(flags.sources).filter((s) => s === 'override').length
  const notes = [
    flags.command ? `from ${flags.command.command}` : '',
    overridden > 0 ? `${overridden} overridden` : ''
  ].filter(Boolean)
  return notes.length > 0 ? `${list} ${p.dim(`(${notes.join('; ')})`)}` : list
}
