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
}

const idRule = (home: string, what: string): RuleInfo => ({
  schema: NameFormatSchema,
  doc: `The form of ${what}'s id, its file name in ${home}/: ${STYLE_NAMES}, or a pattern the whole id matches, where ${FOLDER} is the folder it is in.`
})

/** Every rule, by group, in the order `gta rules` shows them. */
export const RULES = {
  ids: {
    collections: idRule('collections', 'a collection'),
    requests: idRule('requests', 'a request set'),
    bases: idRule('bases', 'a base collection'),
    endpoints: idRule('endpoints', 'an endpoints file')
  },
  layout: {
    folders: {
      schema: RequirementSchema,
      doc: 'required: every collection sits in a folder of collections/, none at its top.'
    },
    folderNames: {
      schema: z.union([NameFormatSchema, z.array(z.string().min(1)).min(1)], {
        error: `is a list of folder names, a style (${STYLE_NAMES}) or a pattern`
      }),
      doc: `The folders of collections/: a list of the names allowed, or a style (${STYLE_NAMES}) or pattern each name follows.`
    },
    maxSteps: {
      schema: z.number({ error: 'is a whole number of steps, 1 or more' }).int().min(1),
      doc: 'The most steps a collection may have in steps:, setup and teardown aside.'
    }
  },
  steps: {
    names: {
      schema: RequirementSchema,
      doc: 'required: every step of a collection or request set has a name of its own, no other step of its file sharing it.'
    },
    url: {
      schema: UrlPatternSchema,
      doc: 'A pattern every request step’s URL matches, as written, {{variables}} and all — ^\\{\\{baseUrl\\}\\} for no host written out. It is not anchored: ^ matches from the start.'
    }
  },
  docs: {
    collections: { schema: RequirementSchema, doc: 'required: every collection has docs.' },
    requests: { schema: RequirementSchema, doc: 'required: every request set has docs.' },
    steps: {
      schema: RequirementSchema,
      doc: 'required: every step of a collection or request set has docs, setup and teardown included.'
    }
  },
  tags: {
    allowed: {
      schema: z.array(TagSchema, { error: 'is a list of tags' }),
      doc: 'The only tags a collection or step may carry.'
    },
    collections: {
      schema: RequirementSchema,
      doc: 'required: every collection has tags: of its own.'
    }
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
    everyStep: {
      schema: RequirementSchema,
      doc: 'required: every step that sends a request or reads a connection is checked by some tests — its own, its file’s, its base collection’s or its endpoint’s. A use step’s requests are checked in their request set.'
    },
    statusCode: {
      schema: RequirementSchema,
      doc: 'required: every request step’s tests check the status code with gta.expectResponseStatusCodeToBe — in its own tests, its file’s, its base collection’s or its endpoint’s, or in a check function they call.'
    }
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

/** What a rule means, as `gta rules` says it. */
export const ruleDoc = (rule: RuleName): string => {
  const [group, key] = rule.split('.') as [RuleGroup, string]
  return (RULES[group] as Record<string, RuleInfo>)[key]!.doc
}

/** The rules in effect: those set, and not turned off. */
export interface Rules {
  ids: { collections?: string; requests?: string; bases?: string; endpoints?: string }
  layout: { folders?: 'required'; folderNames?: string | string[]; maxSteps?: number }
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
  /** As written. `null` and `optional` turn the rule off. */
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

/**
 * Why a file would break the rules where it is about to be written — a new
 * collection, one renamed, moved or copied — or null when it would not: its id
 * under `ids.<home>`, and a collection at the top of `collections/` under
 * `layout.folders`. `folder` is the folder of its home it goes in, null for none.
 */
export function placeProblem(
  loaded: LoadedRules,
  home: LintHome,
  id: string,
  folder: string | null
): string | null {
  const format = loaded.rules.ids[home]
  const problem = format ? nameFormatProblem(id, format, folder) : null
  if (problem) return withRule(loaded, `ids.${home}`, `id: ${id} ${problem}`)
  if (home === COLLECTIONS_DIR && loaded.rules.layout.folders && folder === null) {
    return withRule(loaded, 'layout.folders', 'a collection goes in a folder of collections/ here')
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
