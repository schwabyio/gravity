import { z } from 'zod'
import { BASES_DIR, COLLECTIONS_DIR, ENDPOINTS_DIR, REQUESTS_DIR } from '../format/constants.js'
import { TagSchema, type StepList } from '../model/documents.js'

/**
 * A project's rules (SPEC.md §1.4), as data: what each rule is, the rules in
 * effect, and what breaking one looks like. Pure, so the app's renderer can
 * use it too; reading `rules.yml` is `rules.ts`, checking files `lint.ts`.
 */

/** What `tests.only` can allow (script.ts checks a script against it). */
export const TESTS_ALLOWANCES = ['gta', 'gta.test', 'checks', 'console'] as const
export type TestsAllowance = (typeof TESTS_ALLOWANCES)[number]

/** How a finding names what `tests.only` allows. */
export function allowedText(allowed: readonly TestsAllowance[]): string {
  const names = [
    'gta.*',
    ...(allowed.includes('gta.test') ? ['gta.test'] : []),
    ...(allowed.includes('checks') ? ['checks.*'] : []),
    ...(allowed.includes('console') ? ['console.*'] : [])
  ]
  return names.length === 1
    ? 'gta.* functions'
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

/** Named forms an id or folder name can take, instead of a pattern. */
export const NAME_STYLES: Readonly<Record<string, RegExp>> = {
  'kebab-case': /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
  snake_case: /^[a-z0-9]+(?:_[a-z0-9]+)*$/,
  camelCase: /^[a-z][a-zA-Z0-9]*$/,
  PascalCase: /^[A-Z][a-zA-Z0-9]*$/
}
const STYLE_NAMES = Object.keys(NAME_STYLES).join(', ')

/** What makes a name format a pattern rather than a mistyped style. */
const PATTERN_CHARACTERS = /[\^$.*+?()[\]{}|\\]/
/** In a pattern, the folder the file is in. */
const FOLDER = '{folder}'

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A pattern as a regular expression that matches the whole name. */
const compiled = (pattern: string, folder: string) =>
  new RegExp(`^(?:${pattern.replaceAll(FOLDER, escapeRegExp(folder))})$`)

/** A style name, or a pattern that compiles. */
const NameFormatSchema = z.string().superRefine((format, ctx) => {
  if (Object.hasOwn(NAME_STYLES, format)) return
  if (!PATTERN_CHARACTERS.test(format)) {
    ctx.addIssue({
      code: 'custom',
      message: `"${format}" is not a style (${STYLE_NAMES}), nor a pattern such as ^[a-z]+-[0-9]{3}$`
    })
    return
  }
  try {
    // As written, so a message quotes the pattern the file has.
    new RegExp(format.replaceAll(FOLDER, 'folder'))
  } catch (cause) {
    ctx.addIssue({
      code: 'custom',
      message: `the pattern will not compile: ${(cause as Error).message}`
    })
  }
})

const RequirementSchema = z.enum(['required', 'optional'], {
  error: 'is required or optional'
})

const NoneSchema = z.enum(['none', 'allowed'], { error: 'is none or allowed' })

/** Folders of `collections/`: a list of their names, or a style or pattern each name follows. */
const FolderNamesSchema = z.union([NameFormatSchema, z.array(z.string().min(1)).min(1)], {
  error: `is a list of folder names, a style (${STYLE_NAMES}) or a pattern`
})

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** One kind of collection under `layout.kinds`: what makes a collection one, and where it goes. */
export interface CollectionKind {
  /** A collection with any of these tags of its own is one. */
  tags?: string[]
  /** So is one whose id follows this style or pattern. */
  id?: string
  /** The folders of `collections/` its collections go in, and that hold nothing else. */
  folders: string | string[]
}

const KIND_KEYS: Record<keyof CollectionKind, z.ZodType> = {
  tags: z.array(TagSchema, { error: 'is a list of tags' }).min(1, 'is a list of tags, one or more'),
  id: NameFormatSchema,
  folders: FolderNamesSchema
}

/** `layout.kinds`: each kind by name, its messages naming the kind and the key they are about. */
const KindsSchema = z.unknown().superRefine((kinds, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
  if (!isMap(kinds) || Object.keys(kinds).length === 0) {
    issue(
      'is a map of kinds of collection, such as negative: { tags: [negative], folders: .*-errors }'
    )
    return
  }
  for (const [name, kind] of Object.entries(kinds)) {
    if (!isMap(kind)) {
      issue(`${name}: a map of tags, id and folders`)
      continue
    }
    for (const [key, value] of Object.entries(kind)) {
      const schema = KIND_KEYS[key as keyof CollectionKind] as z.ZodType | undefined
      if (!schema) {
        issue(`${name}.${key}: not part of a kind, which has tags, id and folders`)
        continue
      }
      const result = schema.safeParse(value)
      if (!result.success)
        issue(`${name}.${key}: ${result.error.issues[0]?.message ?? 'not valid'}`)
    }
    if (kind.tags === undefined && kind.id === undefined) {
      issue(`${name}: says what makes a collection one, with tags, id or both`)
    }
    if (kind.folders === undefined)
      issue(`${name}.folders: missing — the folders its collections go in`)
  }
})

/** A pattern a URL matches somewhere, as `RegExp.test` does: it must compile. */
const UrlPatternSchema = z
  .string({ error: 'is a pattern, such as ^\\{\\{baseUrl\\}\\}' })
  .superRefine((pattern, ctx) => {
    try {
      new RegExp(pattern)
    } catch (cause) {
      ctx.addIssue({
        code: 'custom',
        message: `the pattern will not compile: ${(cause as Error).message}`
      })
    }
  })

/** One rule: the values it takes, and what it means, as `gta rules` says it. */
export interface RuleInfo {
  schema: z.ZodType
  doc: string
  /** The value that turns it off, as `null` does: `optional` for a `required` rule. */
  off?: string
}

const required = (doc: string): RuleInfo => ({ schema: RequirementSchema, doc, off: 'optional' })
const none = (doc: string): RuleInfo => ({ schema: NoneSchema, doc, off: 'allowed' })

const idRule = (home: string, what: string): RuleInfo => ({
  schema: NameFormatSchema,
  doc: `The form of ${what}'s id, its file name in ${home}/: ${STYLE_NAMES}, or a pattern the whole id matches, where ${FOLDER} is the folder it is in.`
})

/** Every rule, by group, in the order `gta rules` shows them. */
export const RULES = {
  ids: {
    collections: idRule('collections', 'a collection'),
    requests: idRule('requests', 'a reusable requests file'),
    bases: idRule('bases', 'a base collection'),
    endpoints: idRule('endpoints', 'an endpoints file')
  },
  layout: {
    folders: required(
      'required: every collection sits in a folder of collections/, none at its top.'
    ),
    folderNames: {
      schema: FolderNamesSchema,
      doc: `The folders of collections/: a list of the names allowed, or a style (${STYLE_NAMES}) or pattern each name follows.`
    },
    kinds: {
      schema: KindsSchema,
      doc: 'Kinds of collection, each kept to its own folders. A collection with one of a kind’s tags of its own, or an id following its id style or pattern, goes in one of its folders — a list of names, a style or a pattern — and those folders hold that kind only.'
    },
    maxSteps: {
      schema: z.number({ error: 'is a whole number of steps, 1 or more' }).int().min(1),
      doc: 'The most steps a collection may have in steps:, setup and teardown aside.'
    },
    bases: none(
      'none: no base collections — no file in bases/, and no file extends: one, the global project’s included.'
    ),
    checks: none(
      'none: no check files — no .js file in checks/, and no tests or before.script uses checks.*, the global project’s included.'
    )
  },
  steps: {
    names: required(
      'required: every step of a collection or reusable requests file has a name of its own, no other step of its file sharing it.'
    ),
    url: {
      schema: UrlPatternSchema,
      doc: 'A pattern every request step’s URL matches, as written, {{variables}} and all — ^\\{\\{baseUrl\\}\\} for no host written out. It is not anchored: ^ matches from the start.'
    }
  },
  docs: {
    collections: required('required: every collection has docs.'),
    requests: required('required: every reusable requests file has docs.'),
    steps: required(
      'required: every step of a collection or reusable requests file has docs, setup and teardown included.'
    )
  },
  tags: {
    allowed: {
      schema: z.array(TagSchema, { error: 'is a list of tags' }),
      doc: 'The only tags a collection or step may carry.'
    },
    collections: required('required: every collection has tags: of its own.')
  },
  tests: {
    only: {
      schema: z
        .array(z.enum(TESTS_ALLOWANCES), {
          error: `is a list of what tests may call: ${TESTS_ALLOWANCES.join(', ')}`
        })
        .refine((list) => list.includes('gta'), {
          message: 'must include gta: [gta], plus any of gta.test, checks and console'
        }),
      doc: 'What tests may call. gta: only gta.* calls, each argument a value — written out, read from res, req, params, endpoint, item or gta.get(), JSON.parse or new RegExp — and if on gta.flag() only; no checks.*, gta.test, assert or other code. Add gta.test, checks or console to allow those. before.script is not checked.'
    },
    everyStep: required(
      'required: every step that sends a request or reads a connection is checked by some tests — its own, its file’s, its base collection’s or its endpoint’s. A use step’s requests are checked in their own file.'
    ),
    statusCode: required(
      'required: every request step’s tests check the status code with gta.expectResponseStatusCodeToBe — in its own tests, its file’s, its base collection’s or its endpoint’s, or in a check function they call.'
    )
  }
} as const satisfies Record<string, Record<string, RuleInfo>>

export type RuleGroup = keyof typeof RULES
export type RuleName = {
  [G in RuleGroup]: `${G}.${Extract<keyof (typeof RULES)[G], string>}`
}[RuleGroup]

/** Every rule's name, in table order. */
export const RULE_NAMES = Object.entries(RULES).flatMap(([group, rules]) =>
  Object.keys(rules).map((key) => `${group}.${key}`)
) as RuleName[]

const ruleInfo = (rule: RuleName): RuleInfo => {
  const [group, key] = rule.split('.') as [RuleGroup, string]
  return (RULES[group] as Record<string, RuleInfo>)[key]!
}

/** What a rule means, as `gta rules` says it. */
export const ruleDoc = (rule: RuleName): string => ruleInfo(rule).doc

/** A rule's value as `gta rules` and the app show it: `[gta, console]`, `{negative: {…}}`, `off` for null. */
export function ruleValueText(value: unknown): string {
  if (value === null) return 'off'
  if (Array.isArray(value)) return `[${value.map(ruleValueText).join(', ')}]`
  if (isMap(value)) {
    const entries = Object.entries(value).map(([key, inner]) => `${key}: ${ruleValueText(inner)}`)
    return `{${entries.join(', ')}}`
  }
  return String(value)
}

/** Whether a rule set to `value` is in effect: not `null`, nor its word for off. */
export const ruleIsOn = (rule: RuleName, value: unknown): boolean =>
  value !== null && value !== ruleInfo(rule).off

/** The rules in effect: those set, and not turned off. */
export interface Rules {
  ids: { collections?: string; requests?: string; bases?: string; endpoints?: string }
  layout: {
    folders?: 'required'
    folderNames?: string | string[]
    kinds?: Record<string, CollectionKind>
    maxSteps?: number
    bases?: 'none'
    checks?: 'none'
  }
  steps: { names?: 'required'; url?: string }
  docs: { collections?: 'required'; requests?: 'required'; steps?: 'required' }
  tags: { allowed?: string[]; collections?: 'required' }
  tests: { only?: TestsAllowance[]; everyStep?: 'required'; statusCode?: 'required' }
}

export const noRules = (): Rules => ({
  ids: {},
  layout: {},
  steps: {},
  docs: {},
  tags: {},
  tests: {}
})

/** A rule a `rules.yml` sets, and where: the last file to set it wins. */
export interface RuleSetting {
  rule: RuleName
  /** As written. `null` turns the rule off, as `optional` does a `required` one and `allowed` a `none` one. */
  value: unknown
  /** The file, as the project reaches it: `rules.yml`, or `../shared/rules.yml`. */
  source: string
  /** In effect: not turned off. */
  on: boolean
}

export interface LoadedRules {
  rules: Rules
  /** Each rule a file sets, in table order — those turned off too, so an override shows. */
  settings: RuleSetting[]
  /** The files read, the global project's first, as `source` names them. */
  files: string[]
  /**
   * What each file's `guide:` says, in Markdown, the global project's first:
   * the conventions no rule can check, for people and agents to read.
   */
  guides: RuleGuide[]
}

/** One `rules.yml`'s `guide:`. */
export interface RuleGuide {
  source: string
  text: string
}

/**
 * What is wrong with `name` under a name format — a style or a pattern — or
 * null when it follows it. `folder` is the folder it is in, for `{folder}`.
 */
export function nameFormatProblem(
  name: string,
  format: string,
  folder: string | null
): string | null {
  const style = NAME_STYLES[format]
  if (style) return style.test(name) ? null : `is not ${format}`
  if (format.includes(FOLDER) && folder === null) {
    return `does not match ${format}: it is not in a folder, and the pattern names one`
  }
  return compiled(format, folder ?? '').test(name) ? null : `does not match ${format}`
}

/** The folders a project's collection files sit in, which rules can be about. */
export const LINT_HOMES = [COLLECTIONS_DIR, REQUESTS_DIR, BASES_DIR, ENDPOINTS_DIR] as const
export type LintHome = (typeof LINT_HOMES)[number]

/** Where a file breaks a rule. */
export interface RuleFinding {
  /** From the project folder, with `/`: `collections/payments/refunds.yml`; a folder ends in `/`. */
  file: string
  /** 1-based line in the file, or null for a folder, or a file as a whole. */
  line: number | null
  /** The rule it breaks; null for a file that will not parse, so was not checked. */
  rule: RuleName | null
  /** The file the rule came from: `rules.yml`, or `../shared/rules.yml`. */
  source: string | null
  /** The step it is about, when it is about one: to mark its row. */
  step: { list: StepList; index: number } | null
  message: string
}

/** A rule's finding as a person reads it beside what they did: `… (rule ids.collections in rules.yml)`. */
function withRule(loaded: LoadedRules, rule: RuleName, message: string): string {
  const source = loaded.settings.find((setting) => setting.rule === rule)?.source
  return `${message} (rule ${rule} in ${source ?? 'rules.yml'})`
}

/** What is wrong with a folder name of `collections/` under `layout.folderNames`, or null. */
export function folderNameProblem(loaded: LoadedRules, folder: string): string | null {
  const format = loaded.rules.layout.folderNames
  if (format === undefined) return null
  if (Array.isArray(format)) {
    return format.includes(folder) ? null : `folder ${folder} is not one of: ${format.join(', ')}`
  }
  const problem = nameFormatProblem(folder, format, null)
  return problem ? `folder ${folder} ${problem}` : null
}

/** Whether `folder` is one of a kind's folders: one of a list, or following a style or pattern. */
const isKindFolder = (folder: string, folders: string | readonly string[]): boolean =>
  Array.isArray(folders)
    ? folders.includes(folder)
    : nameFormatProblem(folder, folders as string, null) === null

/** A kind's folders as a finding names them: `a folder matching .*-errors`. */
function kindFoldersText(folders: string | readonly string[]): string {
  if (Array.isArray(folders)) {
    return folders.length === 1
      ? `folder ${folders[0]}`
      : `one of the folders ${folders.join(', ')}`
  }
  const format = folders as string
  return Object.hasOwn(NAME_STYLES, format) ? `a ${format} folder` : `a folder matching ${format}`
}

/** An id style or pattern as a finding names it: `an id matching .*_N`. */
const kindIdText = (format: string) =>
  Object.hasOwn(NAME_STYLES, format) ? `a ${format} id` : `an id matching ${format}`

/** What makes a collection one of a kind: `tagged negative, or with an id matching .*_N`. */
function kindMembersText(kind: CollectionKind): string {
  const tags = kind.tags ?? []
  const tagged =
    tags.length === 0
      ? null
      : `tagged ${tags.length === 1 ? tags[0] : `${tags.slice(0, -1).join(', ')} or ${tags.at(-1)}`}`
  const withId = kind.id === undefined ? null : `with ${kindIdText(kind.id)}`
  return [tagged, withId].filter(Boolean).join(', or ')
}

/** Where a collection breaks `layout.kinds`, for one kind. */
export interface KindProblem {
  kind: string
  /** The tag of its own that makes it one, to point at; null when its id does, or it is not one. */
  tag: string | null
  message: string
}

/**
 * Where a collection with `id`, in `folder` of `collections/` (null for its
 * top), breaks `layout.kinds`: one of a kind outside that kind's folders, or
 * one not of it inside them. `tags` are its own; undefined for a collection
 * not written yet, which can be tagged once it is, so only its id can make it one.
 */
export function kindProblems(
  kinds: Readonly<Record<string, CollectionKind>>,
  id: string,
  folder: string | null,
  tags?: readonly string[]
): KindProblem[] {
  const problems: KindProblem[] = []
  for (const [name, kind] of Object.entries(kinds)) {
    const tag = tags?.find((own) => kind.tags?.includes(own)) ?? null
    const byId = kind.id !== undefined && nameFormatProblem(id, kind.id, folder) === null
    const inFolders = folder !== null && isKindFolder(folder, kind.folders)
    if ((tag !== null || byId) && !inFolders) {
      const why =
        tag !== null
          ? `tag ${tag}`
          : Object.hasOwn(NAME_STYLES, kind.id!)
            ? `its ${kind.id} id`
            : `its id, matching ${kind.id},`
      const where = folder === null ? 'at the top of collections/' : folder
      problems.push({
        kind: name,
        tag,
        message: `${why} makes it ${name}: ${name} collections go in ${kindFoldersText(kind.folders)}, not ${where}`
      })
    } else if (tag === null && !byId && inFolders && !(tags === undefined && kind.tags)) {
      problems.push({
        kind: name,
        tag: null,
        message: `${folder} holds ${name} collections only: those ${kindMembersText(kind)}`
      })
    }
  }
  return problems
}

/** What a finding says under `layout.bases` and `layout.checks`. */
export const NO_BASES = 'base collections are not used here'
export const NO_CHECKS = 'check files are not used here'

/**
 * Why a file would break the rules where it is about to be written — a new
 * collection, one renamed, moved or copied — or null when it would not: any
 * base collection under `layout.bases`, its id under `ids.<home>`, a
 * collection at the top of `collections/` under `layout.folders`, and one in
 * the wrong folder for its kind under `layout.kinds`. `folder` is the folder
 * of its home it goes in, null for none; `tags`, a collection's own, are
 * undefined for a new one.
 */
export function placeProblem(
  loaded: LoadedRules,
  home: LintHome,
  id: string,
  folder: string | null,
  tags?: readonly string[]
): string | null {
  if (home === BASES_DIR && loaded.rules.layout.bases) {
    return withRule(loaded, 'layout.bases', NO_BASES)
  }
  const format = loaded.rules.ids[home]
  const problem = format ? nameFormatProblem(id, format, folder) : null
  if (problem) return withRule(loaded, `ids.${home}`, `id: ${id} ${problem}`)
  if (home === COLLECTIONS_DIR && loaded.rules.layout.folders && folder === null) {
    return withRule(loaded, 'layout.folders', 'a collection goes in a folder of collections/ here')
  }
  const kinds = loaded.rules.layout.kinds
  if (home === COLLECTIONS_DIR && kinds) {
    const [kind] = kindProblems(kinds, id, folder, tags)
    if (kind) return withRule(loaded, 'layout.kinds', kind.message)
  }
  return null
}

/** Why a new or renamed folder of `collections/` would break the rules, or null. */
export function newFolderProblem(loaded: LoadedRules, folder: string): string | null {
  const problem = folderNameProblem(loaded, folder)
  return problem ? withRule(loaded, 'layout.folderNames', problem) : null
}

/** Where the section starts: how a file is known to have it. */
export const AGENTS_SECTION_START = '<!-- gravity:rules -->'
const AGENTS_SECTION_END = '<!-- /gravity:rules -->'

/**
 * The section of an `AGENTS.md` that points coding agents at a project's
 * rules (agents.ts adds it), between markers that say whose it is and where it ends.
 */
export const AGENTS_SECTION = `${AGENTS_SECTION_START}
## API tests

The API tests in this folder are [Gravity](https://github.com/schwabyio/gravity) files. How
they are named, laid out and written is set in \`rules.yml\` here, and in the global project
\`project.yml\` names with \`uses:\`, if any.

- Before adding or changing a test, run \`gta rules\` in this folder: each rule, what it means,
  and the project's guide.
- After, run \`gta lint --json\` in this folder, and fix every finding.
- Without gta installed, \`npx @schwabyio/gta rules\` and \`npx @schwabyio/gta lint --json\`
  do the same.
- The file format is in [SPEC.md](https://github.com/schwabyio/gravity/blob/main/SPEC.md),
  and the \`gta.*\` functions in
  [FUNCTIONS.md](https://github.com/schwabyio/gravity/blob/main/FUNCTIONS.md).
${AGENTS_SECTION_END}
`
