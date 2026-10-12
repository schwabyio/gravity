import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  folderNameProblem,
  nameFormatProblem,
  newFolderProblem,
  placeProblem,
  RULE_NAMES,
  RULES,
  ruleDoc,
  ruleValueText
} from './model.js'
import { loadRules, RulesError } from './rules.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

/** A folder with `files` in it; `uses` is the global project as the project reaches it. */
async function folder(files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-rules-')))
  roots.push(root)
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), body)
  }
  return root
}

describe('loadRules', () => {
  it('has no rules when there is no rules.yml', async () => {
    const root = await folder({})
    expect(await loadRules(root, null)).toEqual({
      rules: { ids: {}, layout: {}, steps: {}, docs: {}, tags: {}, tests: {} },
      settings: [],
      files: [],
      guides: []
    })
  })

  it('lays the project’s rules over its global project’s, rule by rule, saying where each is from', async () => {
    const root = await folder({
      'shared/rules.yml': [
        'ids:',
        '  collections: kebab-case',
        '  requests: camelCase',
        'docs:',
        '  collections: required',
        '  steps: required',
        'tests:',
        '  only: [gta]',
        'tags:',
        '  allowed: [smoke, regression]'
      ].join('\n'),
      'services/shop/rules.yml': [
        'ids:',
        '  collections: ^shop-[a-z-]+$',
        'docs:',
        '  steps: optional',
        'layout:',
        '  maxSteps: 30',
        'tags: null'
      ].join('\n')
    })
    const loaded = await loadRules(path.join(root, 'services/shop'), {
      root: path.join(root, 'shared'),
      uses: '../../shared'
    })
    expect(loaded.files).toEqual(['../../shared/rules.yml', 'rules.yml'])
    expect(loaded.rules).toEqual({
      ids: { collections: '^shop-[a-z-]+$', requests: 'camelCase' },
      layout: { maxSteps: 30 },
      steps: {},
      docs: { collections: 'required' },
      tags: {},
      tests: { only: ['gta'] }
    })
    expect(loaded.settings).toEqual([
      { rule: 'ids.collections', value: '^shop-[a-z-]+$', source: 'rules.yml', on: true },
      { rule: 'ids.requests', value: 'camelCase', source: '../../shared/rules.yml', on: true },
      { rule: 'layout.maxSteps', value: 30, source: 'rules.yml', on: true },
      { rule: 'docs.collections', value: 'required', source: '../../shared/rules.yml', on: true },
      { rule: 'docs.steps', value: 'optional', source: 'rules.yml', on: false },
      { rule: 'tags.allowed', value: null, source: 'rules.yml', on: false },
      { rule: 'tests.only', value: ['gta'], source: '../../shared/rules.yml', on: true }
    ])
  })

  it('lists every rule that is not valid, with its file', async () => {
    const root = await folder({
      'shared/rules.yml': 'ids:\n  collection: kebab-case\nnaming: {}\n',
      'app/rules.yml': [
        'ids:',
        '  collections: kebab',
        '  requests: ^[a-z+$',
        'layout:',
        '  maxSteps: 0',
        '  folders: yes',
        'docs: required',
        'tests:',
        '  only: [checks]',
        'tags:',
        '  allowed: [has space]'
      ].join('\n')
    })
    const error = await loadRules(path.join(root, 'app'), {
      root: path.join(root, 'shared'),
      uses: '../shared'
    }).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(RulesError)
    expect((error as Error).message.split('\n')).toEqual([
      'Rules are not valid (SPEC.md §1.4):',
      '  ids.collection (../shared/rules.yml): not a rule; ids has collections, requests, bases, endpoints',
      '  naming (../shared/rules.yml): not a group of rules; they are ids, layout, steps, docs, tags, tests, and guide',
      '  ids.collections (rules.yml): "kebab" is not a style (kebab-case, snake_case, camelCase, PascalCase), nor a pattern such as ^[a-z]+-[0-9]{3}$',
      expect.stringMatching(/^ {2}ids\.requests \(rules\.yml\): the pattern will not compile: /),
      expect.stringMatching(/^ {2}layout\.maxSteps \(rules\.yml\): /),
      '  layout.folders (rules.yml): is required or optional',
      '  docs (rules.yml): a map of rules, such as docs: { collections: … }, or null',
      '  tests.only (rules.yml): must include gta: [gta], plus any of gta.test, checks and console',
      expect.stringMatching(/^ {2}tags\.allowed \(rules\.yml\): a tag is letters/)
    ])
  })

  it('reads every file’s guide, the global project’s first, and wants it to be Markdown', async () => {
    const root = await folder({
      'shared/rules.yml': 'guide: |\n  # Conventions\n  One collection per resource.\n',
      'app/rules.yml':
        'guide: Login steps use requests/login.\nsteps:\n  url: ^\\{\\{baseUrl\\}\\}\n'
    })
    const global = { root: path.join(root, 'shared'), uses: '../shared' }
    const loaded = await loadRules(path.join(root, 'app'), global)
    expect(loaded.guides).toEqual([
      { source: '../shared/rules.yml', text: '# Conventions\nOne collection per resource.\n' },
      { source: 'rules.yml', text: 'Login steps use requests/login.' }
    ])
    expect(loaded.rules.steps).toEqual({ url: '^\\{\\{baseUrl\\}\\}' })

    await fs.writeFile(path.join(root, 'app/rules.yml'), 'guide: [a, b]\nsteps:\n  url: (\n')
    await expect(loadRules(path.join(root, 'app'), global)).rejects.toThrow(
      /guide \(rules\.yml\): Markdown, written as a block: guide: \|\n {2}steps\.url \(rules\.yml\): the pattern will not compile/
    )
  })

  it('leaves an empty or null guide out, and refuses a url that is not a pattern', async () => {
    const root = await folder({ 'rules.yml': "guide: ''\n" })
    expect((await loadRules(root, null)).guides).toEqual([])
    await fs.writeFile(path.join(root, 'rules.yml'), 'guide: null\n')
    expect((await loadRules(root, null)).guides).toEqual([])
    await fs.writeFile(path.join(root, 'rules.yml'), 'steps:\n  url: 5\n')
    await expect(loadRules(root, null)).rejects.toThrow(
      'steps.url (rules.yml): is a pattern, such as ^\\{\\{baseUrl\\}\\}'
    )
  })

  it('turns layout.bases and layout.checks off with allowed, as optional does a required rule', async () => {
    const root = await folder({
      'shared/rules.yml': 'layout:\n  bases: none\n  checks: none\nsteps:\n  url: optional\n',
      'app/rules.yml': 'layout:\n  checks: allowed\n'
    })
    const loaded = await loadRules(path.join(root, 'app'), {
      root: path.join(root, 'shared'),
      uses: '../shared'
    })
    expect(loaded.rules.layout).toEqual({ bases: 'none' })
    // Each rule by its own word: a URL pattern may be any text, optional too.
    expect(loaded.rules.steps).toEqual({ url: 'optional' })
    expect(loaded.settings.map(({ rule, on }) => [rule, on])).toEqual([
      ['layout.bases', true],
      ['layout.checks', false],
      ['steps.url', true]
    ])

    await fs.writeFile(path.join(root, 'app/rules.yml'), 'layout:\n  bases: optional\n')
    await expect(loadRules(path.join(root, 'app'), null)).rejects.toThrow(
      'layout.bases (rules.yml): is none or allowed'
    )
  })

  it('turns off a group only where a file under it set its rules', async () => {
    const root = await folder({
      'shared/rules.yml': 'docs:\n  collections: required\n',
      'app/rules.yml': 'docs: null\ntags: null\n'
    })
    const loaded = await loadRules(path.join(root, 'app'), {
      root: path.join(root, 'shared'),
      uses: '../shared'
    })
    expect(loaded.settings).toEqual([
      { rule: 'docs.collections', value: null, source: 'rules.yml', on: false }
    ])
    expect(loaded.rules.docs).toEqual({})
  })

  it('names the file that is not a map of rules', async () => {
    const root = await folder({ 'rules.yml': '- ids\n' })
    const error = await loadRules(root, null).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(RulesError)
    expect((error as Error).message).toBe(
      'rules.yml must be a map, such as ids: { collections: kebab-case }'
    )
  })

  it('says which file will not parse', async () => {
    const root = await folder({ 'rules.yml': 'ids: [' })
    await expect(loadRules(root, null)).rejects.toThrow('rules.yml will not parse')
  })

  it('reads layout.kinds, naming the kind and key of each mistake', async () => {
    const root = await folder({
      'rules.yml': [
        'layout:',
        '  kinds:',
        '    negative:',
        '      tags: [negative]',
        "      id: '.*_N'",
        "      folders: '.*-errors'"
      ].join('\n')
    })
    expect((await loadRules(root, null)).rules.layout.kinds).toEqual({
      negative: { tags: ['negative'], id: '.*_N', folders: '.*-errors' }
    })

    await fs.writeFile(
      path.join(root, 'rules.yml'),
      [
        'layout:',
        '  kinds:',
        '    negative:',
        '      tags: [not negative]',
        '      folder: errors',
        '    slow:',
        '      folders: [slow]',
        '    smoke: smoke'
      ].join('\n')
    )
    const error = await loadRules(root, null).catch((cause: unknown) => cause)
    expect((error as Error).message).toBe(
      [
        'Rules are not valid (SPEC.md §1.4):',
        '  layout.kinds (rules.yml): negative.tags: a tag is letters, digits and - _ . : with no spaces'
      ].join('\n')
    )

    // Every mistake is checked, though loadRules shows each rule's first.
    const kinds = (value: unknown) => {
      const issues = RULES.layout.kinds.schema.safeParse(value).error?.issues ?? []
      return issues.map((issue) => issue.message)
    }
    expect(
      kinds({
        negative: { tags: [], folder: 'errors' },
        slow: { folders: ['slow'] },
        smoke: 'smoke'
      })
    ).toEqual([
      'negative.tags: is a list of tags, one or more',
      'negative.folder: not part of a kind, which has tags, id and folders',
      'negative.folders: missing — the folders its collections go in',
      'slow: says what makes a collection one, with tags, id or both',
      'smoke: a map of tags, id and folders'
    ])
    expect(kinds({})).toEqual([
      'is a map of kinds of collection, such as negative: { tags: [negative], folders: .*-errors }'
    ])
    expect(kinds({ negative: { id: 'kebab', folders: '.*-errors' } })).toEqual([
      'negative.id: "kebab" is not a style (kebab-case, snake_case, camelCase, PascalCase), nor a pattern such as ^[a-z]+-[0-9]{3}$'
    ])
  })

  it('shows a value as gta rules does, a map of kinds included', () => {
    expect(ruleValueText(null)).toBe('off')
    expect(ruleValueText(['gta', 'console'])).toBe('[gta, console]')
    expect(ruleValueText(30)).toBe('30')
    expect(
      ruleValueText({ negative: { tags: ['negative'], id: '.*_N', folders: '.*-errors' } })
    ).toBe('{negative: {tags: [negative], id: .*_N, folders: .*-errors}}')
  })

  it('documents every rule', () => {
    for (const rule of RULE_NAMES) expect(ruleDoc(rule).length).toBeGreaterThan(20)
  })
})

describe('nameFormatProblem', () => {
  it('checks a style', () => {
    expect(nameFormatProblem('create-user', 'kebab-case', null)).toBeNull()
    expect(nameFormatProblem('404-handling', 'kebab-case', null)).toBeNull()
    expect(nameFormatProblem('createUser', 'kebab-case', null)).toBe('is not kebab-case')
    expect(nameFormatProblem('create_user', 'snake_case', null)).toBeNull()
    expect(nameFormatProblem('createUser', 'camelCase', null)).toBeNull()
    expect(nameFormatProblem('CreateUser', 'camelCase', null)).toBe('is not camelCase')
    expect(nameFormatProblem('CreateUser', 'PascalCase', null)).toBeNull()
  })

  it('matches a pattern against the whole name, {folder} standing for the folder', () => {
    expect(nameFormatProblem('ACC-001-login', '[A-Z]{3}-\\d{3}-[a-z-]+', null)).toBeNull()
    expect(nameFormatProblem('xACC-001-login', '[A-Z]{3}-\\d{3}-[a-z-]+', null)).toBe(
      'does not match [A-Z]{3}-\\d{3}-[a-z-]+'
    )
    expect(nameFormatProblem('payments-refunds', '{folder}-[a-z-]+', 'payments')).toBeNull()
    expect(nameFormatProblem('orders-refunds', '{folder}-[a-z-]+', 'payments')).toBe(
      'does not match {folder}-[a-z-]+'
    )
    // A folder name is taken as it is, not as a pattern.
    expect(nameFormatProblem('a.b-x', '{folder}-x', 'a.b')).toBeNull()
    expect(nameFormatProblem('aXb-x', '{folder}-x', 'a.b')).toBe('does not match {folder}-x')
    expect(nameFormatProblem('refunds', '{folder}-[a-z-]+', null)).toBe(
      'does not match {folder}-[a-z-]+: it is not in a folder, and the pattern names one'
    )
  })
})

describe('placeProblem and newFolderProblem', () => {
  it('says why a file or folder about to be written would break a rule, and whose rule it is', async () => {
    const root = await folder({
      'shared/rules.yml': 'ids:\n  collections: kebab-case\n',
      'app/rules.yml': 'layout:\n  folders: required\n  folderNames: [payments]\n'
    })
    const loaded = await loadRules(path.join(root, 'app'), {
      root: path.join(root, 'shared'),
      uses: '../shared'
    })
    expect(placeProblem(loaded, 'collections', 'CreateUser', 'payments')).toBe(
      'id: CreateUser is not kebab-case (rule ids.collections in ../shared/rules.yml)'
    )
    expect(placeProblem(loaded, 'collections', 'create-user', null)).toBe(
      'a collection goes in a folder of collections/ here (rule layout.folders in rules.yml)'
    )
    expect(placeProblem(loaded, 'collections', 'create-user', 'payments')).toBeNull()
    // Only collections go in folders by rule; a request set's id has no rule here.
    expect(placeProblem(loaded, 'requests', 'AnyThing', null)).toBeNull()
    expect(newFolderProblem(loaded, 'orders')).toBe(
      'folder orders is not one of: payments (rule layout.folderNames in rules.yml)'
    )
    expect(newFolderProblem(loaded, 'payments')).toBeNull()
  })

  it('checks each home by its own id rule, and a folder name by a style or pattern', async () => {
    const root = await folder({
      'rules.yml':
        'ids:\n  requests: camelCase\n  bases: ^base-.+\nlayout:\n  folderNames: kebab-case\n'
    })
    const loaded = await loadRules(root, null)
    expect(placeProblem(loaded, 'requests', 'get-token', null)).toBe(
      'id: get-token is not camelCase (rule ids.requests in rules.yml)'
    )
    expect(placeProblem(loaded, 'requests', 'getToken', null)).toBeNull()
    expect(placeProblem(loaded, 'bases', 'authed', null)).toBe(
      'id: authed does not match ^base-.+ (rule ids.bases in rules.yml)'
    )
    // No rule for collections here: any id, anywhere, goes.
    expect(placeProblem(loaded, 'collections', 'Anything', null)).toBeNull()
    expect(newFolderProblem(loaded, 'Payments')).toBe(
      'folder Payments is not kebab-case (rule layout.folderNames in rules.yml)'
    )
    expect(folderNameProblem(loaded, 'payments')).toBeNull()

    const none = await loadRules(await folder({}), null)
    expect(newFolderProblem(none, 'Any Thing')).toBeNull()
    expect(placeProblem(none, 'collections', 'Any', null)).toBeNull()
  })

  it('keeps each kind of collection to its folders, and its folders to it', async () => {
    const root = await folder({
      'rules.yml': [
        'layout:',
        '  kinds:',
        '    negative:',
        '      tags: [negative, error]',
        "      id: '.*_N'",
        "      folders: '.*-errors'",
        '    slow:',
        '      tags: [slow]',
        '      folders: [slow]'
      ].join('\n')
    })
    const loaded = await loadRules(root, null)
    const rule = ' (rule layout.kinds in rules.yml)'
    expect(placeProblem(loaded, 'collections', 'create_N', 'orders-errors')).toBeNull()
    expect(placeProblem(loaded, 'collections', 'create', 'orders-errors', ['error'])).toBeNull()
    expect(placeProblem(loaded, 'collections', 'create', 'orders', [])).toBeNull()
    expect(placeProblem(loaded, 'collections', 'create', null, [])).toBeNull()
    expect(placeProblem(loaded, 'collections', 'create_N', 'orders')).toBe(
      `its id, matching .*_N, makes it negative: negative collections go in a folder matching .*-errors, not orders${rule}`
    )
    expect(placeProblem(loaded, 'collections', 'create', null, ['smoke', 'error'])).toBe(
      `tag error makes it negative: negative collections go in a folder matching .*-errors, not at the top of collections/${rule}`
    )
    expect(placeProblem(loaded, 'collections', 'create', 'orders-errors', ['smoke'])).toBe(
      `orders-errors holds negative collections only: those tagged negative or error, or with an id matching .*_N${rule}`
    )
    // A new collection can be tagged once it is written: only its id can say what it is.
    expect(placeProblem(loaded, 'collections', 'create', 'orders-errors')).toBeNull()
    expect(placeProblem(loaded, 'collections', 'nightly', 'orders', ['slow'])).toBe(
      `tag slow makes it slow: slow collections go in folder slow, not orders${rule}`
    )
    expect(placeProblem(loaded, 'collections', 'nightly', 'slow', ['smoke'])).toBe(
      `slow holds slow collections only: those tagged slow${rule}`
    )
    // Only collections have kinds.
    expect(placeProblem(loaded, 'requests', 'create_N', null)).toBeNull()

    await fs.writeFile(
      path.join(root, 'rules.yml'),
      'layout:\n  kinds:\n    errors:\n      id: snake_case\n      folders: [bad-input, not-found]\n'
    )
    const byId = await loadRules(root, null)
    expect(placeProblem(byId, 'collections', 'missing_id', 'orders')).toBe(
      'its snake_case id makes it errors: errors collections go in one of the folders bad-input, not-found, not orders (rule layout.kinds in rules.yml)'
    )
    // With no tags to give it, a new collection's id says what it is.
    expect(placeProblem(byId, 'collections', 'missing-id', 'not-found')).toBe(
      'not-found holds errors collections only: those with a snake_case id (rule layout.kinds in rules.yml)'
    )
  })

  it('refuses any base collection under layout.bases, whatever its id', async () => {
    const root = await folder({
      'rules.yml': 'ids:\n  bases: kebab-case\nlayout:\n  bases: none\n'
    })
    const loaded = await loadRules(root, null)
    expect(placeProblem(loaded, 'bases', 'authed', null)).toBe(
      'base collections are not used here (rule layout.bases in rules.yml)'
    )
    expect(placeProblem(loaded, 'collections', 'authed', null)).toBeNull()
  })
})
