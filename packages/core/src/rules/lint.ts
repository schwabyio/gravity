import fs from 'node:fs/promises'
import path from 'node:path'
import YAML, { LineCounter } from 'yaml'
import { BASES_DIR, COLLECTIONS_DIR, ENDPOINTS_DIR, REQUESTS_DIR } from '../format/constants.js'
import { parseCollection } from '../format/index.js'
import { sourceLine } from '../format/lines.js'
import {
  isReadStep,
  isUseStep,
  readRequestLine,
  STEP_LISTS,
  stepLabel,
  type Collection,
  type Step,
  type StepList
} from '../model/documents.js'
import { findEndpoint, type EndpointPattern } from '../model/endpoints.js'
import { relativePosix } from '../paths.js'
import { idOfFile } from '../workspace/ids.js'
import { libraryFiles, listBases, loadChecks, loadEndpoints } from '../workspace/library.js'
import { discoverProject, type GlobalProject } from '../workspace/project.js'
import {
  folderNameProblem,
  LINT_HOMES,
  nameFormatProblem,
  type LintHome,
  type LoadedRules,
  type RuleFinding,
  type RuleName
} from './model.js'
import { checksStatusCode, statusCheckFunctions, testsScriptFindings } from './script.js'

/**
 * Checking a project's files against its rules (SPEC.md §1.4). What breaks a
 * rule is a finding: it is reported, and never stops a run.
 */

/** A collection-shaped file to check. */
export interface LintFile {
  home: LintHome
  /** Its place in its home, with `/`: `payments/refunds.yml`. */
  relativePath: string
  source: string
}

const isBlank = (text: string | undefined) => text === undefined || text.trim() === ''

/** The line a node of a YAML file starts on, or null when there is no such node. */
function locator(source: string) {
  const lineCounter = new LineCounter()
  const document = YAML.parseDocument(source, { lineCounter })
  return (at: Array<string | number>): number | null => {
    const node = document.getIn(at, true)
    return YAML.isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line : null
  }
}

/**
 * What a project's steps inherit, for the rules about their tests: the tests
 * of endpoint bases and base collections, and the check functions that check
 * a status code (SPEC.md §2.6, §2.7, §5).
 */
export interface LintContext {
  /** Every endpoint base requests match, the project's first: its file's tests and its own. */
  endpoints: Array<EndpointPattern & { tests: string[] }>
  /** The tests of the base collection an `extends:` names, if it has any. */
  baseTests: (reference: string) => string | undefined
  /** Check functions that check the status code, as `file.function`. */
  statusChecks: ReadonlySet<string>
}

/** Nothing inherited: a file checked on its own. */
export const NO_LINT_CONTEXT: LintContext = {
  endpoints: [],
  baseTests: () => undefined,
  statusChecks: new Set()
}

/** What the project at `root` and its global project give their steps' tests. */
export async function lintContext(
  root: string,
  global: Pick<GlobalProject, 'root'> | null
): Promise<LintContext> {
  const endpoints = (await loadEndpoints(root, global)).map((endpoint) => ({
    method: endpoint.method,
    path: endpoint.path,
    tests: [endpoint.file.tests, endpoint.step.tests].filter(
      (code): code is string => !isBlank(code)
    )
  }))
  const bases = await listBases(root, global)
  // As `extends:` finds a base: the project's first, then its global project's;
  // `global:name` only the global project's.
  const baseTests = (reference: string) => {
    const onlyGlobal = reference.startsWith(GLOBAL_PREFIX)
    const name = onlyGlobal ? reference.slice(GLOBAL_PREFIX.length) : reference
    const found =
      (onlyGlobal ? undefined : bases.find((b) => b.source === 'project' && b.name === name)) ??
      bases.find((b) => b.source === 'global' && b.name === name)
    return found?.doc?.tests
  }
  const statusChecks = statusCheckFunctions(await loadChecks(root, global))
  return { endpoints, baseTests, statusChecks }
}

const GLOBAL_PREFIX = 'global:'

/** Every rule one file breaks; `context`, what its steps inherit, for the rules about tests. */
export function lintFile(
  file: LintFile,
  loaded: LoadedRules,
  context: LintContext = NO_LINT_CONTEXT
): RuleFinding[] {
  const { rules } = loaded
  const where = `${file.home}/${file.relativePath}`
  const source = (rule: RuleName) =>
    loaded.settings.find((setting) => setting.rule === rule)?.source ?? null

  let doc: Collection
  try {
    doc = parseCollection(file.source, where).data
  } catch (cause) {
    return [
      {
        file: where,
        line: null,
        rule: null,
        source: null,
        step: null,
        message: `will not parse, so no rule was checked: ${(cause as Error).message}`
      }
    ]
  }

  const findings: RuleFinding[] = []
  const lineOf = locator(file.source)
  const fileLine = () => lineOf(['id']) ?? 1
  type At = { list: StepList; index: number } | null
  const find = (rule: RuleName, line: number | null, message: string, step: At = null) =>
    findings.push({ file: where, line, rule, source: source(rule), step, message })

  const parts = file.relativePath.split('/')
  const folder = parts.length > 1 ? parts[0]! : null
  const id = idOfFile(file.relativePath)

  const idFormat = rules.ids[file.home]
  if (idFormat) {
    const problem = nameFormatProblem(id, idFormat, folder)
    if (problem) find(`ids.${file.home}`, fileLine(), `id: ${id} ${problem}`)
  }

  /** Each step of each list, with how a finding names it: `setup step 2 (seed)`. */
  const steps = STEP_LISTS.flatMap((list: StepList) =>
    (doc[list] ?? []).map((step, index) => {
      const short = `${list === 'steps' ? '' : `${list} `}step ${index + 1}`
      return { step, list, index, short, name: `${short} (${stepLabel(step)})` }
    })
  )
  /** What a step does: send a request, run a request set, or read a connection. */
  const kindOf = (step: Step) => (isUseStep(step) ? 'use' : isReadStep(step) ? 'read' : 'request')

  if (file.home === COLLECTIONS_DIR) {
    if (rules.layout.folders && folder === null) {
      find(
        'layout.folders',
        fileLine(),
        'sits at the top of collections/; every collection goes in a folder'
      )
    }
    const max = rules.layout.maxSteps
    if (max !== undefined && doc.steps.length > max) {
      find(
        'layout.maxSteps',
        lineOf(['steps', max]),
        `${doc.steps.length} steps; a collection has at most ${max}`
      )
    }
    if (rules.docs.collections && isBlank(doc.docs)) find('docs.collections', fileLine(), 'no docs')
    if (rules.tags.collections && (doc.tags ?? []).length === 0) {
      find('tags.collections', fileLine(), 'no tags')
    }
    const allowed = rules.tags.allowed
    if (allowed) {
      const notAllowed = (tag: string) =>
        allowed.length === 0
          ? `tag ${tag}: no tags are used here`
          : `tag ${tag} is not one of: ${allowed.join(', ')}`
      ;(doc.tags ?? []).forEach((tag, i) => {
        if (!allowed.includes(tag)) find('tags.allowed', lineOf(['tags', i]), notAllowed(tag))
      })
      for (const { step, list, index, name } of steps) {
        ;(step.tags ?? []).forEach((tag, i) => {
          if (allowed.includes(tag)) return
          find('tags.allowed', lineOf([list, index, 'tags', i]), `${name}: ${notAllowed(tag)}`, {
            list,
            index
          })
        })
      }
    }
  }

  if (file.home === REQUESTS_DIR && rules.docs.requests && isBlank(doc.docs)) {
    find('docs.requests', fileLine(), 'no docs')
  }
  if (rules.docs.steps && (file.home === COLLECTIONS_DIR || file.home === REQUESTS_DIR)) {
    for (const { step, list, index, name } of steps) {
      if (isBlank(step.docs)) {
        find('docs.steps', lineOf([list, index]), `${name}: no docs`, { list, index })
      }
    }
  }

  // What steps say of themselves: endpoints are patterns, not steps of a run.
  const runs = file.home === COLLECTIONS_DIR || file.home === REQUESTS_DIR
  if (rules.steps.names && runs) {
    const named = new Map<string, string>()
    for (const { step, list, index, short, name } of steps) {
      const own = step.name?.trim() ?? ''
      const first = named.get(own)
      if (own === '') {
        find('steps.names', lineOf([list, index]), `${name}: no name`, { list, index })
      } else if (first) {
        find(
          'steps.names',
          lineOf([list, index, 'name']) ?? lineOf([list, index]),
          `${name}: ${first} has the same name`,
          { list, index }
        )
      } else {
        named.set(own, short)
      }
    }
  }
  const urlPattern = rules.steps.url
  if (urlPattern !== undefined && runs) {
    const pattern = new RegExp(urlPattern)
    for (const { step, list, index, name } of steps) {
      if (kindOf(step) !== 'request') continue
      const { method, url } = readRequestLine(step)
      if (pattern.test(url)) continue
      find(
        'steps.url',
        lineOf([list, index, method]) ?? lineOf([list, index]),
        `${name}: URL ${url} does not match ${urlPattern}`,
        { list, index }
      )
    }
  }

  // Which tests check a step: its endpoint's, its file's base's, its file's and its own.
  if ((rules.tests.everyStep || rules.tests.statusCode) && runs) {
    const checksStatus = new Map<string, boolean>()
    const statusIn = (code: string) => {
      if (!checksStatus.has(code)) {
        checksStatus.set(code, checksStatusCode(code, context.statusChecks))
      }
      return checksStatus.get(code)!
    }
    const base = doc.extends ? context.baseTests(doc.extends) : undefined
    for (const { step, list, index, name } of steps) {
      const kind = kindOf(step)
      // A use step's requests are steps of their request set, checked there.
      if (kind === 'use') continue
      const request = kind === 'request' && step.base !== false ? readRequestLine(step) : null
      const endpoint = request ? findEndpoint(request.method, request.url, context.endpoints) : null
      const tests = [...(endpoint?.tests ?? []), base, doc.tests, step.tests].filter(
        (code): code is string => !isBlank(code)
      )
      const at = { list, index }
      if (rules.tests.everyStep && tests.length === 0) {
        find(
          'tests.everyStep',
          lineOf([list, index]),
          `${name}: no tests check it — its own, its file’s, its base collection’s or its endpoint’s`,
          at
        )
      }
      if (rules.tests.statusCode && kind === 'request' && !tests.some(statusIn)) {
        find(
          'tests.statusCode',
          lineOf([list, index]),
          `${name}: no tests check its status code with gta.expectResponseStatusCodeToBe`,
          at
        )
      }
    }
  }

  const only = rules.tests.only
  if (only) {
    const scripts = [
      { code: doc.tests, name: 'tests', step: null },
      ...steps.map(({ step, list, index, name }) => ({
        code: step.tests,
        name: `${name} tests`,
        step: { list, index }
      }))
    ]
    for (const script of scripts) {
      if (isBlank(script.code)) continue
      for (const finding of testsScriptFindings(script.code!, only)) {
        const line =
          sourceLine(file.source, {
            ...(script.step ? { step: script.step } : {}),
            script: 'tests',
            scriptLine: finding.line
          }) ?? null
        find('tests.only', line, `${script.name}: ${finding.message}`, script.step)
      }
    }
  }

  return findings.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
}

/** The folders of `collections/` that break a rule about their names. */
export function lintFolders(folders: readonly string[], loaded: LoadedRules): RuleFinding[] {
  const source = loaded.settings.find((s) => s.rule === 'layout.folderNames')?.source ?? null
  return folders.flatMap((folder) => {
    const message = folderNameProblem(loaded, folder)
    return message
      ? [
          {
            file: `${COLLECTIONS_DIR}/${folder}/`,
            line: null,
            rule: 'layout.folderNames' as const,
            source,
            step: null,
            message
          }
        ]
      : []
  })
}

export interface LintResult {
  /** In file order: `collections/` first, each folder before its files. */
  findings: RuleFinding[]
  /** How many files of each home were checked. */
  checked: Record<LintHome, number>
}

/**
 * Check every file of the project at `root` — its own, not its global
 * project's — against `loaded`. The global project gives the steps' tests
 * what they inherit from it: its endpoint bases, base collections and checks.
 */
export async function lintProject(
  root: string,
  loaded: LoadedRules,
  global: Pick<GlobalProject, 'root'> | null = null
): Promise<LintResult> {
  const layout = await discoverProject(root)
  const { everyStep, statusCode } = loaded.rules.tests
  const context = everyStep || statusCode ? await lintContext(root, global) : NO_LINT_CONTEXT
  const filesOf: Record<LintHome, string[]> = {
    [COLLECTIONS_DIR]: layout.files,
    [REQUESTS_DIR]: await libraryFiles(root, REQUESTS_DIR),
    [BASES_DIR]: await libraryFiles(root, BASES_DIR),
    [ENDPOINTS_DIR]: await libraryFiles(root, ENDPOINTS_DIR)
  }

  const findings: RuleFinding[] = []
  const checked = {} as Record<LintHome, number>
  for (const home of LINT_HOMES) {
    const files = [...filesOf[home]].sort((a, b) => a.localeCompare(b))
    checked[home] = files.length
    const inHome: RuleFinding[] =
      home === COLLECTIONS_DIR ? lintFolders(layout.directories, loaded) : []
    for (const file of files) {
      const relativePath = relativePosix(path.join(root, home), file)
      let source: string
      try {
        source = await fs.readFile(file, 'utf8')
      } catch (cause) {
        inHome.push({
          file: `${home}/${relativePath}`,
          line: null,
          rule: null,
          source: null,
          step: null,
          message: `cannot be read, so no rule was checked: ${(cause as Error).message}`
        })
        continue
      }
      inHome.push(...lintFile({ home, relativePath, source }, loaded, context))
    }
    // A folder's finding before its files', and each file's in line order.
    findings.push(...inHome.sort((a, b) => a.file.localeCompare(b.file)))
  }
  return { findings, checked }
}
