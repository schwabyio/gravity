import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { lintContext, lintFile, lintFolders, lintProject, type LintContext } from './lint.js'
import type { LoadedRules } from './model.js'
import { loadRules } from './rules.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gta-lint-')))
  roots.push(root)
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), body)
  }
  return root
}

/** Rules as `rules.yml` would hold them, all from that one file. */
async function rules(yaml: string): Promise<LoadedRules> {
  const root = await project({ 'rules.yml': yaml })
  return loadRules(root, null)
}

const lines = (...text: string[]) => `${text.join('\n')}\n`

describe('lintFile', () => {
  it('checks a collection’s id, folder, steps, docs and tags', async () => {
    const loaded = await rules(
      lines(
        'ids:',
        '  collections: kebab-case',
        'layout:',
        '  folders: required',
        '  maxSteps: 1',
        'docs:',
        '  collections: required',
        '  steps: required',
        'tags:',
        '  allowed: [smoke, regression]',
        '  collections: required'
      )
    )
    const source = lines(
      'id: CreateUser',
      'stepTags: true',
      'steps:',
      '  - name: create',
      '    POST: /users',
      '    docs: Makes one.',
      '  - name: read',
      '    GET: /users/1',
      '    tags: [nightly]'
    )
    expect(
      lintFile({ home: 'collections', relativePath: 'CreateUser.yml', source }, loaded)
    ).toEqual([
      {
        file: 'collections/CreateUser.yml',
        line: 1,
        rule: 'ids.collections',
        source: 'rules.yml',
        step: null,
        message: 'id: CreateUser is not kebab-case'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 1,
        rule: 'layout.folders',
        source: 'rules.yml',
        step: null,
        message: 'sits at the top of collections/; every collection goes in a folder'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 1,
        rule: 'docs.collections',
        source: 'rules.yml',
        step: null,
        message: 'no docs'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 1,
        rule: 'tags.collections',
        source: 'rules.yml',
        step: null,
        message: 'no tags'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 7,
        rule: 'layout.maxSteps',
        source: 'rules.yml',
        step: null,
        message: '2 steps; a collection has at most 1'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 7,
        rule: 'docs.steps',
        source: 'rules.yml',
        step: { list: 'steps', index: 1 },
        message: 'step 2 (read): no docs'
      },
      {
        file: 'collections/CreateUser.yml',
        line: 9,
        rule: 'tags.allowed',
        source: 'rules.yml',
        step: { list: 'steps', index: 1 },
        message: 'step 2 (read): tag nightly is not one of: smoke, regression'
      }
    ])
  })

  it('passes a collection that follows every rule', async () => {
    const loaded = await rules(
      lines(
        'ids: { collections: "{folder}-[a-z-]+" }',
        'layout: { folders: required, maxSteps: 1 }',
        'steps: { names: required, url: "^/" }',
        'docs: { collections: required, steps: required }',
        'tags: { allowed: [smoke], collections: required }',
        'tests: { only: [gta], everyStep: required, statusCode: required }'
      )
    )
    const source = lines(
      'id: users-create',
      'docs: Creates a user.',
      'tags: [smoke]',
      'tests: |',
      '  gta.expectResponseToHaveHeader("content-type")',
      'steps:',
      '  - name: create',
      '    docs: Makes one.',
      '    POST: /users',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(201)'
    )
    expect(
      lintFile({ home: 'collections', relativePath: 'users/users-create.yml', source }, loaded)
    ).toEqual([])
  })

  it('points tests.only at the line in the file, for the collection’s tests and each list’s steps', async () => {
    const loaded = await rules('tests:\n  only: [gta]\n')
    const source = lines(
      'id: checkout',
      'tests: |',
      '  gta.expectResponseToHaveHeader("x-trace")',
      '  console.log(res.status)',
      'setup:',
      '  - name: seed',
      '    POST: /seed',
      '    tests: |',
      '      checks.seed.done()',
      'steps:',
      '  - name: pay',
      '    POST: /pay',
      '    tests: |',
      '      gta.expectResponseStatusCodeToBe(200)',
      '',
      "      gta.test('total', () => assert.ok(res.body.total > 0))"
    )
    expect(
      lintFile({ home: 'collections', relativePath: 'checkout.yml', source }, loaded).map(
        ({ line, message }) => [line, message]
      )
    ).toEqual([
      [4, 'tests: console.log(res.status): tests here call only gta.* functions'],
      [
        9,
        'setup step 1 (seed) tests: checks.seed.done(): check files are not used here; tests here call only gta.* functions'
      ],
      [
        16,
        "step 1 (pay) tests: gta.test('total', () => assert.ok(res.body.total > 0)): gta.test runs a check of your own; tests here call only gta.* functions"
      ]
    ])
  })

  it('checks each library home by its own rules', async () => {
    const loaded = await rules(
      lines(
        'ids: { requests: camelCase, bases: snake_case, endpoints: kebab-case }',
        'docs: { requests: required, steps: required }',
        'tests: { only: [gta] }'
      )
    )
    const set = lines(
      'id: create-user',
      'params: { name: string }',
      'steps:',
      '  - POST: /users',
      '    tests: checks.users.created()'
    )
    expect(
      lintFile({ home: 'requests', relativePath: 'auth/create-user.yml', source: set }, loaded).map(
        (finding) => [finding.rule, finding.line, finding.message]
      )
    ).toEqual([
      ['ids.requests', 1, 'id: create-user is not camelCase'],
      ['docs.requests', 1, 'no docs'],
      ['docs.steps', 4, 'step 1 (POST /users): no docs'],
      [
        'tests.only',
        5,
        'step 1 (POST /users) tests: checks.users.created(): check files are not used here; tests here call only gta.* functions'
      ]
    ])
    // An endpoint's steps need no docs, and a base has no steps.
    expect(
      lintFile(
        {
          home: 'endpoints',
          relativePath: 'users.yml',
          source: lines('id: users', 'steps:', '  - GET: /users/{id}')
        },
        loaded
      )
    ).toEqual([])
    expect(
      lintFile(
        { home: 'bases', relativePath: 'authed-calls.yml', source: 'id: authed-calls\n' },
        loaded
      ).map((finding) => finding.message)
    ).toEqual(['id: authed-calls is not snake_case'])
  })

  it('says so when tags.allowed allows none', async () => {
    const loaded = await rules('tags:\n  allowed: []\n')
    expect(
      lintFile(
        { home: 'collections', relativePath: 'a.yml', source: 'id: a\ntags: [smoke]\n' },
        loaded
      ).map((finding) => finding.message)
    ).toEqual(['tag smoke: no tags are used here'])
  })

  it('checks tests.only in a base collection’s tests and an endpoint’s', async () => {
    const loaded = await rules('tests:\n  only: [gta]\n')
    expect(
      lintFile(
        {
          home: 'bases',
          relativePath: 'authed.yml',
          source: lines('id: authed', 'tests: |', '  assert.ok(res.status < 500)')
        },
        loaded
      ).map((finding) => [finding.line, finding.message])
    ).toEqual([[3, 'tests: assert.ok(res.status < 500): tests here call only gta.* functions']])
    expect(
      lintFile(
        {
          home: 'endpoints',
          relativePath: 'users.yml',
          source: lines(
            'id: users',
            'steps:',
            '  - GET: /users/{id}',
            '    tests: checks.users.expectUser()'
          )
        },
        loaded
      ).map((finding) => [finding.line, finding.message, finding.step])
    ).toEqual([
      [
        4,
        'step 1 (GET /users/{id}) tests: checks.users.expectUser(): check files are not used here; tests here call only gta.* functions',
        { list: 'steps', index: 0 }
      ]
    ])
  })

  it('reports a file that will not parse as not checked', async () => {
    const loaded = await rules('docs: { collections: required }\n')
    expect(
      lintFile(
        { home: 'collections', relativePath: 'bad.yml', source: 'id: bad\nheders: {}\n' },
        loaded
      )
    ).toEqual([
      {
        file: 'collections/bad.yml',
        line: null,
        rule: null,
        source: null,
        step: null,
        message: expect.stringMatching(/^will not parse, so no rule was checked: /)
      }
    ])
  })
})

describe('the steps and tests rules', () => {
  it('wants every step named, no two alike, and every URL to match the pattern', async () => {
    const loaded = await rules(lines('steps:', '  names: required', '  url: ^\\{\\{baseUrl\\}\\}'))
    const source = lines(
      'id: users',
      'setup:',
      '  - name: seed',
      "    POST: '{{baseUrl}}/seed'",
      'steps:',
      "  - GET: '{{baseUrl}}/users'",
      '  - name: seed',
      '    GET: http://localhost:8080/users/1',
      '  - name: login',
      '    use: login',
      '  - connection: feed'
    )
    expect(
      lintFile({ home: 'collections', relativePath: 'users.yml', source }, loaded).map(
        (finding) => [finding.rule, finding.line, finding.message, finding.step]
      )
    ).toEqual([
      ['steps.names', 6, 'step 1 (GET {{baseUrl}}/users): no name', { list: 'steps', index: 0 }],
      [
        'steps.names',
        7,
        'step 2 (seed): setup step 1 has the same name',
        { list: 'steps', index: 1 }
      ],
      [
        'steps.url',
        8,
        'step 2 (seed): URL http://localhost:8080/users/1 does not match ^\\{\\{baseUrl\\}\\}',
        { list: 'steps', index: 1 }
      ],
      ['steps.names', 11, 'step 4 (read feed): no name', { list: 'steps', index: 3 }]
    ])
    // An endpoint is a method and a path pattern: no name or URL rule for it.
    expect(
      lintFile(
        {
          home: 'endpoints',
          relativePath: 'users.yml',
          source: lines('id: users', 'steps:', '  - GET: /users/{id}')
        },
        loaded
      )
    ).toEqual([])
  })

  it('counts the tests a step inherits: its file’s, its base collection’s and its endpoint’s', async () => {
    const loaded = await rules(lines('tests:', '  everyStep: required', '  statusCode: required'))
    const context: LintContext = {
      endpoints: [
        { method: 'GET', path: '/orders/{id}', tests: ['gta.expectResponseStatusCodeToBe(200)'] },
        { method: 'DELETE', path: '/orders/{id}', tests: [] }
      ],
      baseTests: (reference) =>
        reference === 'authed' ? "gta.expectResponseToHaveHeader('x-trace')" : undefined,
      statusChecks: new Set(['common.expectJson'])
    }
    const source = lines(
      'id: orders',
      'extends: authed',
      'steps:',
      "  - name: read, its endpoint's tests check the status",
      "    GET: '{{baseUrl}}/orders/7'",
      '  - name: read, its base left out',
      "    GET: '{{baseUrl}}/orders/7'",
      '    base: false',
      '  - name: delete, only the base collection checks it',
      "    DELETE: '{{baseUrl}}/orders/7'",
      '  - name: through a check function',
      "    POST: '{{baseUrl}}/orders'",
      '    tests: checks.common.expectJson(201)',
      '  - name: inside an if on a flag',
      "    PUT: '{{baseUrl}}/orders/7'",
      '    tests: |',
      "      if (gta.flag('v2')) gta.expectResponseStatusCodeToBe(204)",
      '  - name: the set checks its own',
      '    use: create-order',
      '  - name: events',
      '    connection: feed'
    )
    const file = { home: 'collections' as const, relativePath: 'orders.yml', source }
    expect(lintFile(file, loaded, context).map((finding) => finding.message)).toEqual([
      'step 2 (read, its base left out): no tests check its status code with gta.expectResponseStatusCodeToBe',
      'step 3 (delete, only the base collection checks it): no tests check its status code with gta.expectResponseStatusCodeToBe'
    ])
    // With no base, a request and a read with no tests at all are found.
    const bare = lines(
      'id: bare',
      'steps:',
      '  - name: nothing checks it',
      "    DELETE: '{{baseUrl}}/orders/7'",
      '  - name: nor this',
      '    connection: feed'
    )
    expect(
      lintFile({ ...file, relativePath: 'bare.yml', source: bare }, loaded, context).map(
        (finding) => [finding.rule, finding.message]
      )
    ).toEqual([
      [
        'tests.everyStep',
        'step 1 (nothing checks it): no tests check it — its own, its file’s, its base collection’s or its endpoint’s'
      ],
      [
        'tests.statusCode',
        'step 1 (nothing checks it): no tests check its status code with gta.expectResponseStatusCodeToBe'
      ],
      [
        'tests.everyStep',
        'step 2 (nor this): no tests check it — its own, its file’s, its base collection’s or its endpoint’s'
      ]
    ])
  })

  it('checks a file on its own when given nothing it inherits', async () => {
    const loaded = await rules('tests:\n  everyStep: required\n')
    const source = lines('id: orders', 'extends: authed', 'steps:', "  - GET: '{{baseUrl}}/orders'")
    expect(
      lintFile({ home: 'collections', relativePath: 'orders.yml', source }, loaded).map(
        (finding) => finding.rule
      )
    ).toEqual(['tests.everyStep'])
  })

  it('finds what a project’s steps inherit from its global project too', async () => {
    const root = await project({
      'shared/project.yml': 'name: shared\n',
      'shared/checks/common.js': lines(
        'export function expectJson(status) {',
        '  gta.expectResponseStatusCodeToBe(status)',
        "  gta.expectResponseToHaveHeader('content-type', /json/)",
        '}',
        'export const expectFast = (ms) => gta.test("fast", () => assert.ok(res.time < ms))'
      ),
      'shared/endpoints/health.yml': lines(
        'id: health',
        'steps:',
        '  - GET: /health',
        '    tests: gta.expectResponseStatusCodeToBe(200)'
      ),
      'shop/project.yml': 'uses: ../shared\n',
      'shop/rules.yml': 'tests:\n  statusCode: required\n',
      'shop/collections/smoke.yml': lines(
        'id: smoke',
        'steps:',
        '  - name: up',
        "    GET: '{{baseUrl}}/health'",
        '  - name: json',
        "    GET: '{{baseUrl}}/orders'",
        '    tests: checks.common.expectJson(200)',
        '  - name: fast',
        "    GET: '{{baseUrl}}/orders'",
        '    tests: checks.common.expectFast(200)'
      )
    })
    const shop = path.join(root, 'shop')
    const global = { root: path.join(root, 'shared') }
    const result = await lintProject(shop, await loadRules(shop, null), global)
    expect(result.findings.map((finding) => finding.message)).toEqual([
      'step 3 (fast): no tests check its status code with gta.expectResponseStatusCodeToBe'
    ])
  })
})

describe('lintContext', () => {
  it('finds a base as extends: does, the project’s first, global: only the global project’s', async () => {
    const root = await project({
      'shared/project.yml': 'name: shared\n',
      'shared/bases/authed.yml': 'id: authed\ntests: gta.expectResponseStatusCodeToBe(200)\n',
      'shared/bases/plain.yml': 'id: plain\n',
      'shared/endpoints/users.yml': lines(
        'id: users',
        'tests: gta.expectResponseToHaveHeader("x-trace")',
        'steps:',
        '  - GET: /users/{id}',
        '    tests: gta.expectResponseStatusCodeToBe(200)',
        '  - DELETE: /users/{id}'
      ),
      'shop/bases/authed.yml': 'id: authed\ntests: gta.expectResponseToHaveHeader("x-user")\n'
    })
    const context = await lintContext(path.join(root, 'shop'), { root: path.join(root, 'shared') })
    expect(context.baseTests('authed')).toBe('gta.expectResponseToHaveHeader("x-user")')
    expect(context.baseTests('global:authed')).toBe('gta.expectResponseStatusCodeToBe(200)')
    expect(context.baseTests('plain')).toBeUndefined()
    expect(context.baseTests('nowhere')).toBeUndefined()
    expect(context.endpoints).toEqual([
      {
        method: 'GET',
        path: '/users/{id}',
        tests: [
          'gta.expectResponseToHaveHeader("x-trace")',
          'gta.expectResponseStatusCodeToBe(200)'
        ]
      },
      {
        method: 'DELETE',
        path: '/users/{id}',
        tests: ['gta.expectResponseToHaveHeader("x-trace")']
      }
    ])
    expect(context.statusChecks).toEqual(new Set())

    // Without a global project, global: finds nothing.
    const alone = await lintContext(path.join(root, 'shop'), null)
    expect(alone.baseTests('global:authed')).toBeUndefined()
  })
})

describe('lintFolders', () => {
  it('checks folder names against a list, a style or a pattern', async () => {
    const folders = ['payments', 'Orders', 'misc']
    expect(
      lintFolders(folders, await rules('layout: { folderNames: [payments, orders] }\n')).map(
        (finding) => [finding.file, finding.message]
      )
    ).toEqual([
      ['collections/Orders/', 'folder Orders is not one of: payments, orders'],
      ['collections/misc/', 'folder misc is not one of: payments, orders']
    ])
    expect(
      lintFolders(folders, await rules('layout: { folderNames: kebab-case }\n')).map(
        (finding) => finding.message
      )
    ).toEqual(['folder Orders is not kebab-case'])
  })
})

describe('lintProject', () => {
  it('checks the project’s own files in every home, folders first, and counts them', async () => {
    const root = await project({
      'rules.yml': lines(
        'ids: { collections: kebab-case, requests: kebab-case }',
        'layout: { folderNames: [payments] }'
      ),
      'collections/payments/refunds.yml': 'id: refunds\n',
      'collections/payments/Refunds_old.yml': 'id: Refunds_old\n',
      'collections/orders/list.yml': 'id: list\n',
      'collections/broken.yml': 'id: broken\nsteps: [\n',
      'requests/login.yml': 'id: login\nparams: {}\n',
      'requests/auth/Logout.yml': 'id: Logout\nparams: {}\n',
      'bases/authed.yml': 'id: authed\n'
    })
    const result = await lintProject(root, await loadRules(root, null))
    expect(result.checked).toEqual({ collections: 4, requests: 2, bases: 1, endpoints: 0 })
    expect(result.findings.map((finding) => `${finding.file} ${finding.message}`)).toEqual([
      expect.stringMatching(/^collections\/broken\.yml will not parse, so no rule was checked: /),
      'collections/orders/ folder orders is not one of: payments',
      'collections/payments/Refunds_old.yml id: Refunds_old is not kebab-case',
      'requests/auth/Logout.yml id: Logout is not kebab-case'
    ])
  })

  // A file the user cannot read: chmod means nothing to Windows, nor to root.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports a file it cannot read as not checked',
    async () => {
      const root = await project({
        'rules.yml': 'docs:\n  collections: required\n',
        'collections/locked.yml': 'id: locked\n'
      })
      const file = path.join(root, 'collections/locked.yml')
      await fs.chmod(file, 0o000)
      try {
        const result = await lintProject(root, await loadRules(root, null))
        expect(result.findings).toEqual([
          {
            file: 'collections/locked.yml',
            line: null,
            rule: null,
            source: null,
            step: null,
            message: expect.stringMatching(/^cannot be read, so no rule was checked: EACCES/)
          }
        ])
      } finally {
        await fs.chmod(file, 0o644)
      }
    }
  )
})
