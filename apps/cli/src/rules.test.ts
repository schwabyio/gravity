import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXIT, main } from './main.js'
import { inProcessRunner } from './pool.js'
import { makeProject } from './testProject.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>) {
  const root = await makeProject(files)
  roots.push(root)
  return root
}

async function gta(root: string, ...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    cwd: root,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    color: false,
    runner: () => inProcessRunner,
    open: () => {}
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

const lines = (...text: string[]) => `${text.join('\n')}\n`

/** A monorepo: a service using a global project whose rules.yml it builds on. */
const monorepo = {
  'shared/project.yml': 'name: shared\n',
  'shared/rules.yml': lines(
    'ids:',
    '  collections: kebab-case',
    'docs:',
    '  collections: required',
    'tests:',
    '  only: [gta]'
  ),
  'shop/project.yml': 'name: Shop\nuses: ../shared\n',
  'shop/rules.yml': lines('docs:', '  collections: optional', 'layout:', '  folders: required'),
  'shop/collections/orders/list-orders.yml': lines(
    'id: list-orders',
    'steps:',
    '  - GET: /orders',
    '    tests: |',
    '      gta.expectResponseStatusCodeToBe(200)'
  )
}

describe('gta --help', () => {
  it('lists lint and rules among the commands', async () => {
    const { code, out } = await gta('/', '--help')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('    lint            Check the project’s files against its rules')
    expect(out).toContain('    rules           List the rules in effect')
    expect(out).toContain('A collection called all, get, lint or rules: give it as all.yml.')
  })
})

describe('gta lint', () => {
  it('passes a project that follows its rules, and its global project’s', async () => {
    const root = await project(monorepo)
    const { code, out } = await gta(path.join(root, 'shop'), 'lint')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Rules from:   ../shared/rules.yml, rules.yml')
    expect(out).toContain('In effect:    3 rules (gta rules lists them)')
    expect(out).toContain(
      'Checked:      1 collection, 0 reusable requests files, 0 base collections, 0 endpoints files'
    )
    expect(out).toContain('No findings: every file follows the rules.')
  })

  it('lists each finding at its file and line, with its rule and where the rule is from, and fails', async () => {
    const root = await project({
      ...monorepo,
      'shop/collections/Refund.yml': lines(
        'id: Refund',
        'steps:',
        '  - POST: /refunds',
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(201)',
        '      checks.money.isRefunded()'
      )
    })
    const { code, out } = await gta(path.join(root, 'shop'), 'lint')
    expect(code).toBe(EXIT.failed)
    expect(out.split('\n').filter((line) => line.startsWith('collections/'))).toEqual([
      'collections/Refund.yml:1  id: Refund is not kebab-case  [ids.collections from ../shared/rules.yml]',
      'collections/Refund.yml:1  sits at the top of collections/; every collection goes in a folder  [layout.folders from rules.yml]',
      'collections/Refund.yml:6  step 1 (POST /refunds) tests: checks.money.isRefunded(): check files are not used here; tests here call only gta.* functions  [tests.only from ../shared/rules.yml]'
    ])
    expect(out).toContain('3 findings in 1 file')

    const json = JSON.parse((await gta(path.join(root, 'shop'), 'lint', '--json')).out)
    expect(json.files).toEqual(['../shared/rules.yml', 'rules.yml'])
    expect(json.rules).toMatchObject({
      ids: { collections: 'kebab-case' },
      layout: { folders: 'required' },
      docs: {},
      tests: { only: ['gta'] }
    })
    expect(json.checked).toEqual({ collections: 2, requests: 0, bases: 0, endpoints: 0 })
    expect(json.findings[0]).toEqual({
      file: 'collections/Refund.yml',
      line: 1,
      rule: 'ids.collections',
      source: '../shared/rules.yml',
      step: null,
      message: 'id: Refund is not kebab-case'
    })
  })

  it('counts what a step inherits from the global project toward tests.statusCode', async () => {
    const root = await project({
      ...monorepo,
      'shared/rules.yml': 'tests:\n  statusCode: required\n',
      'shared/bases/json-api.yml': 'id: json-api\ntests: checks.common.expectJson(200)\n',
      'shared/checks/common.js':
        'export function expectJson(status) {\n  gta.expectResponseStatusCodeToBe(status)\n}\n',
      'shop/collections/orders/by-base.yml': lines(
        'id: by-base',
        'extends: json-api',
        'steps:',
        '  - GET: /orders'
      ),
      'shop/collections/orders/unchecked.yml': lines('id: unchecked', 'steps:', '  - GET: /orders')
    })
    const { code, out } = await gta(path.join(root, 'shop'), 'lint')
    expect(code).toBe(EXIT.failed)
    expect(out.split('\n').filter((line) => line.startsWith('collections/'))).toEqual([
      'collections/orders/unchecked.yml:3  step 1 (GET /orders): no tests check its status code with gta.expectResponseStatusCodeToBe  [tests.statusCode from ../shared/rules.yml]'
    ])
  })

  it('runs in a global project’s folder, with no collections/ or settings.yml', async () => {
    const root = await project({
      'shared/project.yml': 'name: shared\n',
      'shared/rules.yml': 'ids:\n  requests: camelCase\n',
      'shared/requests/get-token.yml': 'id: get-token\nparams: {}\n'
    })
    const { code, out } = await gta(path.join(root, 'shared'), 'lint')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain(
      'requests/get-token.yml:1  id: get-token is not camelCase  [ids.requests from rules.yml]'
    )
  })

  it('prints a folder’s finding without a line, and a file it could not check in red words', async () => {
    const root = await project({
      ...monorepo,
      'shop/rules.yml': lines(
        'docs:',
        '  collections: optional',
        'layout:',
        '  folderNames: [orders]'
      ),
      'shop/collections/misc/ping.yml': 'id: ping\n',
      'shop/collections/orders/broken.yml': 'id: broken\nsteps: [\n'
    })
    const { code, out } = await gta(path.join(root, 'shop'), 'lint')
    expect(code).toBe(EXIT.failed)
    const found = out.split('\n').filter((line) => line.startsWith('collections/'))
    expect(found[0]).toBe(
      'collections/misc/  folder misc is not one of: orders  [layout.folderNames from rules.yml]'
    )
    expect(found[1]).toMatch(
      /^collections\/orders\/broken\.yml {2}will not parse, so no rule was checked: /
    )
    expect(out).toContain('2 findings in 2 files')
  })

  it('has nothing to check without rules', async () => {
    const root = await project({ 'collections/a.yml': 'id: a\n' })
    const { code, out } = await gta(root, 'lint')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Rules:        none: no rules.yml here')
    expect(out).toContain('Nothing to check.')
  })

  it('will not run with rules that are not valid, a project.yml it cannot follow, or settings given', async () => {
    const root = await project({
      'collections/a.yml': 'id: a\n',
      'rules.yml': 'ids:\n  collection: kebab-case\n'
    })
    const invalid = await gta(root, 'lint')
    expect(invalid.code).toBe(EXIT.unusable)
    expect(invalid.err).toContain(
      'ids.collection (rules.yml): not a rule; ids has collections, requests, bases, endpoints'
    )
    const asJson = JSON.parse((await gta(root, 'lint', '--json')).out)
    expect(asJson.error.exitCode).toBe(EXIT.unusable)

    const lost = await project({ 'collections/a.yml': 'id: a\n', 'project.yml': 'uses: ../gone\n' })
    const unfollowed = await gta(lost, 'lint')
    expect(unfollowed.code).toBe(EXIT.unusable)
    expect(unfollowed.err).toContain('project.yml must be fixed first, to know which rules apply')

    const settings = await gta(lost, 'lint', '--limitConcurrency', '4')
    expect(settings.code).toBe(EXIT.unusable)
    expect(settings.err).toContain('gta lint takes no settings or flags: --limitConcurrency')
    const flags = await gta(lost, 'rules', '--flag', 'newCheckout=true')
    expect(flags.code).toBe(EXIT.unusable)
    expect(flags.err).toContain('gta rules takes no settings or flags: --flag')

    const nowhere = await project({})
    expect((await gta(nowhere, 'rules')).err).toContain('There is no collections/ or project.yml')
  })
})

describe('gta rules', () => {
  it('prints each file’s guide after the rules, the global project’s first', async () => {
    const root = await project({
      ...monorepo,
      'shared/rules.yml': lines(
        monorepo['shared/rules.yml'],
        'guide: |',
        '  # House style',
        '',
        '  Name steps for what they prove.'
      ),
      'shop/rules.yml': lines(monorepo['shop/rules.yml'], 'guide: Logins use requests/login.')
    })
    const { out } = await gta(path.join(root, 'shop'), 'rules')
    expect(out).toContain(
      [
        'Guide (../shared/rules.yml)',
        '  # House style',
        '',
        '  Name steps for what they prove.',
        '',
        'Guide (rules.yml)',
        '  Logins use requests/login.'
      ].join('\n')
    )
    const json = JSON.parse((await gta(path.join(root, 'shop'), 'rules', '--json')).out)
    expect(json.guides).toEqual([
      { source: '../shared/rules.yml', text: '# House style\n\nName steps for what they prove.\n' },
      { source: 'rules.yml', text: 'Logins use requests/login.' }
    ])
  })

  it('says where it looked when there are no rules, and prints a guide alone', async () => {
    const root = await project({
      'shared/project.yml': 'name: shared\n',
      'shop/project.yml': 'uses: ../shared\n',
      'shop/collections/a.yml': 'id: a\n',
      'solo/collections/a.yml': 'id: a\n'
    })
    expect((await gta(path.join(root, 'shop'), 'rules')).out).toContain(
      'Rules:        none: no rules.yml here or in ../shared'
    )
    expect((await gta(path.join(root, 'solo'), 'rules')).out).toContain(
      'Rules:        none: no rules.yml here'
    )

    await fs.writeFile(path.join(root, 'shared/rules.yml'), 'guide: Every step has a name.\n')
    const { code, out } = await gta(path.join(root, 'shop'), 'rules')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Rules from:   ../shared/rules.yml')
    expect(out).toContain('Guide (../shared/rules.yml)\n  Every step has a name.')
    const lint = await gta(path.join(root, 'shop'), 'lint')
    expect(lint.code).toBe(EXIT.passed)
    expect(lint.out).toContain('Nothing to check.')
  })

  it('shows a rule a project turned off with null as off', async () => {
    const root = await project({
      ...monorepo,
      'shop/rules.yml': 'tests: null\n'
    })
    const { out } = await gta(path.join(root, 'shop'), 'rules')
    expect(out).toMatch(/^tests\.only +off +rules\.yml$/m)
  })

  it('lists each rule set, its value and file, those turned off too, and what each means', async () => {
    const root = await project(monorepo)
    const { code, out } = await gta(path.join(root, 'shop'), 'rules')
    expect(code).toBe(EXIT.passed)
    expect(out.split('\n').filter((line) => /^[a-z]+\.[a-zA-Z]+ /.test(line))).toEqual([
      'ids.collections   kebab-case  ../shared/rules.yml',
      'layout.folders    required    rules.yml',
      'docs.collections  optional    rules.yml',
      'tests.only        [gta]       ../shared/rules.yml'
    ])
    expect(out).toContain('    What tests may call. gta: only gta.* calls')

    const json = JSON.parse((await gta(path.join(root, 'shop'), 'rules', '--json')).out)
    expect(json.rules[2]).toEqual({
      rule: 'docs.collections',
      value: 'optional',
      source: 'rules.yml',
      on: false,
      doc: 'required: every collection has docs.'
    })
  })
})
