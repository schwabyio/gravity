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
  ruleDoc
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
})
