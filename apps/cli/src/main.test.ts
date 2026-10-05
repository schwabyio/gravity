import fs from 'node:fs/promises'
import https from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, main } from './main.js'
import { inProcessRunner } from './pool.js'
import { collection, makeProject, startServer } from './testProject.js'

let server: Awaited<ReturnType<typeof startServer>>
beforeAll(async () => {
  server = await startServer()
})
afterAll(() => server.close())

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function project(files: Record<string, string>) {
  const root = await makeProject({
    'settings.yml': 'environmentType: local\nlimitConcurrency: 2\n',
    'environments/local.yml': `name: local\nvars:\n  baseUrl: ${server.origin}\n`,
    ...files
  })
  roots.push(root)
  return root
}

const opened: string[] = []

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
    open: (file) => opened.push(file)
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

describe('gta', () => {
  it('prints usage with no command, needing no project', async () => {
    const { code, out } = await gta('/')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Usage: gta <command>')
    expect(out).toContain('--limitConcurrency')
    expect(out).toContain('Exits 1 on a broken collection, or a use:, extends: or body')
  })

  it('refuses a folder with no collections/', async () => {
    const root = await project({})
    const { code, err } = await gta(root, 'all')
    expect(code).toBe(EXIT.unusable)
    expect(err).toContain('There is no collections/')
  })

  it('lists collections with get', async () => {
    const root = await project({
      'collections/smoke.yml': collection('smoke', ['/ok'], 'tags: [smoke]'),
      'collections/checkout/sessions.yml': collection('sessions', ['/ok', '/ok'])
    })
    const { code, out } = await gta(root, 'get')
    expect(code).toBe(EXIT.passed)
    expect(out).toMatch(/1 {2}sessions +2 {8}checkout/)
    // The Folder column is as wide as checkout, its longest entry.
    expect(out).toMatch(/2 {2}smoke +1 {18}smoke/)
    expect(out).toContain('2 collections, 3 steps')
  })

  it('runs all, passing', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok', '/ok']),
      'collections/b.yml': collection('b', ['/ok'])
    })
    const { code, out } = await gta(root, 'all')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Environment:  local')
    expect(out).toContain('Collections:  2 total, 2 passed, 0 failed')
    expect(out).toContain('Steps:        3 total, 3 passed')
    expect(out).toContain('PASSED')
  })

  it('counts a collection whose every step was skipped as skipped, not passed', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok']),
      'collections/gated.yml': collection('gated', ['/ok', '/ok'], 'flags: { newCheckout: true }')
    })
    const { code, out } = await gta(root, 'all', '--flag', 'newCheckout=false')
    // Nothing failed: the run passes.
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Collections:  2 total, 1 passed, 0 failed, 1 skipped')
    expect(out).toContain('Steps:        3 total, 1 passed, 0 failed, 0 errored, 2 skipped')
    expect(out).toContain('PASSED')

    const json = JSON.parse((await gta(root, 'all', '--flag', 'newCheckout=false', '--json')).out)
    expect(json.run.result).toBe('passed')
    expect(json.totals.collections).toEqual({ total: 2, passed: 1, failed: 0, skipped: 1 })
    expect(json.collections.map((c: { id: string; status: string }) => [c.id, c.status])).toEqual([
      ['a', 'passed'],
      ['gated', 'skipped']
    ])
  })

  it('fails the run on a failing assertion, and says which', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok', '/fail'])
    })
    const { code, out } = await gta(root, 'a')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain('Failures')
    expect(out).toContain('✗ get /fail 500')
    expect(out).toContain('FAILED')
  })

  it('reports a collection that will not parse instead of skipping it', async () => {
    const root = await project({
      'collections/good.yml': collection('good', ['/ok']),
      'collections/bad.yml': 'steps: [\n'
    })
    const { code, out } = await gta(root, 'all')
    expect(code).toBe(EXIT.failed)
    expect(out).toMatch(/bad .* failed/)
    expect(out).toContain('Collections:  2 total, 1 passed, 1 failed')

    const listed = await gta(root, 'get')
    expect(listed.code).toBe(EXIT.failed)
    expect(listed.out).toContain('broken bad:')
  })

  it('reports a wrong or shared id as broken, and runs neither', async () => {
    const root = await project({
      'collections/good.yml': collection('good', ['/ok']),
      'collections/renamed.yml': collection('old-name', ['/ok']),
      'collections/checkout/login.yml': collection('login', ['/ok']),
      'collections/admin/Login.yml': collection('Login', ['/ok'])
    })
    const { code, out } = await gta(root, 'all')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain('id: old-name does not match the file name, renamed.yml')
    expect(out).toContain('id: login is also the id of collections/admin/Login.yml')
    expect(out).toContain('Collections:  4 total, 1 passed, 3 failed')
  })

  it('runs only tagged steps from a collection with step tags', async () => {
    const root = await project({
      'collections/a.yml': [
        'id: a',
        'stepTags: true',
        'steps:',
        "  - GET: '{{baseUrl}}/ok'",
        '    tags: [smoke]',
        "  - GET: '{{baseUrl}}/fail'"
      ].join('\n')
    })
    const { code, out } = await gta(root, 'all', '--tags', 'smoke')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Steps:        1 total, 1 passed')
  })

  it('leaves out what notTags names: whole collections, and steps where steps carry tags', async () => {
    const root = await project({
      'collections/quick.yml': collection('quick', ['/ok'], 'tags: [api]'),
      'collections/long.yml': collection('long', ['/ok', '/ok'], 'tags: [api, slow]'),
      'collections/mixed.yml': [
        'id: mixed',
        'stepTags: true',
        'steps:',
        "  - GET: '{{baseUrl}}/ok'",
        '    tags: [api]',
        "  - GET: '{{baseUrl}}/fail'",
        '    tags: [api, slow]'
      ].join('\n')
    })
    const { code, out } = await gta(root, 'all', '--tags', 'api', '--notTags', 'slow')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Not tags:     slow')
    expect(out).toContain('2 to run (1 left out by tags)')
    expect(out).toContain('Steps:        2 total, 2 passed')

    const listed = JSON.parse((await gta(root, 'get', '--json', '--notTags', 'slow')).out)
    expect(listed.notTags).toEqual(['slow'])
    expect(listed.collections.map((c: { id: string; steps: number[] }) => [c.id, c.steps])).toEqual(
      [
        ['mixed', [0]],
        ['quick', [0]]
      ]
    )
  })

  it('runs only what the list names, and fails on a name that matches nothing', async () => {
    const root = await project({
      'collections/one.yml': collection('one', ['/ok']),
      'collections/two.yml': collection('two', ['/fail'])
    })
    const ran = await gta(root, 'one')
    expect(ran.code).toBe(EXIT.passed)
    expect(ran.out).toContain('Collections:  1 total, 1 passed')

    const unknown = await gta(root, 'one,nope')
    expect(unknown.code).toBe(EXIT.unusable)
    expect(unknown.err).toContain('"nope"')
  })

  it('runs a collection named like a command when given with .yml', async () => {
    const root = await project({
      'collections/all.yml': collection('all', ['/ok']),
      'collections/lint.yml': collection('lint', ['/ok']),
      'collections/rules.yml': collection('rules', ['/ok']),
      'collections/other.yml': collection('other', ['/fail'])
    })
    for (const name of ['all', 'lint', 'rules']) {
      const { code, out } = await gta(root, `${name}.yml`)
      expect(code).toBe(EXIT.passed)
      expect(out).toContain('Collections:  1 total, 1 passed')
    }
  })

  it('leaves an excluded collection out of all, and runs it when named', async () => {
    const root = await project({
      'collections/good.yml': collection('good', ['/ok']),
      'collections/wip.yml': collection('wip', ['/fail'], 'exclude: true')
    })
    const listed = await gta(root, 'get')
    expect(listed.out).toContain('Excluded:     wip (exclude: true)')
    expect(listed.out).toContain('1 collections, 1 steps')

    const all = await gta(root, 'all')
    expect(all.code).toBe(EXIT.passed)
    expect(all.out).toContain('1 to run (1 excluded)')

    const named = await gta(root, 'wip')
    expect(named.code).toBe(EXIT.failed)
    expect(named.out).toContain('Collections:  1 total, 0 passed, 1 failed')
  })

  it('checks every collection with get, those all leaves out too, and fails on a problem', async () => {
    const root = await project({
      'requests/login.yml': [
        'id: login',
        'params:',
        '  user: { required: true }',
        'steps:',
        "  - GET: '{{baseUrl}}/ok'",
        ''
      ].join('\n'),
      'collections/good.yml': 'id: good\nsteps:\n  - use: login\n    with: { user: a }\n',
      'collections/typo.yml': [
        'id: typo',
        'steps:',
        "  - GET: '{{baseUrl}}/ok'",
        '  - use: login',
        '    with: { usr: a }',
        ''
      ].join('\n'),
      'collections/slow.yml': 'id: slow\ntags: [slow]\nsteps:\n  - use: login\n',
      'collections/wip.yml': 'id: wip\nexclude: true\nextends: nope\nsteps:\n  - use: logon\n',
      'collections/old.yml': 'id: olde\nexclude: true\nsteps: []\n'
    })
    const listed = await gta(root, 'get', '--notTags', 'slow')
    expect(listed.code).toBe(EXIT.failed)
    expect(listed.out).toContain(
      'broken old (excluded): id: olde does not match the file name, old.yml — they must be the same (SPEC.md §2)'
    )
    expect(listed.out).toContain(
      'broken slow (left out by tags), step 1: use: login — needs user in with:'
    )
    expect(listed.out).toContain(
      'broken typo, step 2: use: login — it takes no usr (it takes: user)'
    )
    expect(listed.out).toContain(
      'broken wip (excluded): extends: nope — there is no nope.yml in bases/'
    )
    expect(listed.out).toContain(
      'broken wip (excluded), step 1: use: logon — there is no logon.yml in requests/'
    )
    expect(listed.out).not.toContain('broken good')

    const listedJson = await gta(root, 'get', '--json', '--notTags', 'slow')
    expect(listedJson.code).toBe(EXIT.failed)
    const json = JSON.parse(listedJson.out)
    expect(json.problems).toEqual([
      {
        id: 'old',
        leftOut: 'excluded',
        step: null,
        message:
          'id: olde does not match the file name, old.yml — they must be the same (SPEC.md §2)'
      },
      { id: 'slow', leftOut: 'tags', step: 0, message: 'use: login — needs user in with:' },
      {
        id: 'typo',
        leftOut: null,
        step: 1,
        message: 'use: login — it takes no usr (it takes: user)'
      },
      {
        id: 'wip',
        leftOut: 'excluded',
        step: null,
        message: 'extends: nope — there is no nope.yml in bases/'
      },
      {
        id: 'wip',
        leftOut: 'excluded',
        step: 0,
        message: 'use: logon — there is no logon.yml in requests/'
      }
    ])
  })

  it('runs setup once, the steps once per data row, then teardown, each reported by its list', async () => {
    const root = await project({
      'collections/seed.yml': [
        'id: seed',
        'setup:',
        '  - name: grant',
        "    POST: '{{baseUrl}}/ok/grant'",
        '    tests: |',
        "      gta.set('roots', ['r1', 'r2'], { scope: 'run' })",
        'steps:',
        '  - name: write',
        "    PUT: '{{baseUrl}}/ok/{{who}}'",
        '    before:',
        '      script: |',
        "        if (gta.get('who') === 'none') gta.skip('nothing for this row')",
        'teardown:',
        '  - name: revoke',
        "    DELETE: '{{baseUrl}}/ok/{{item}}'",
        "    forEach: '{{roots}}'",
        ''
      ].join('\n'),
      'collections/seed.csv': 'who\na\nnone\n',
      'collections/broken.yml': 'id: broken\nsetup:\n  - use: nope\nsteps:\n  - GET: /x\n'
    })
    const ran = await gta(root, 'seed')
    expect(ran.code).toBe(EXIT.passed)
    expect(ran.out).toContain('Steps:        5 total, 4 passed, 0 failed, 0 errored, 1 skipped')

    const json = JSON.parse((await gta(root, 'seed', '--json')).out)
    const steps = json.collections[0].steps as Array<{
      stage?: string
      step: { index: number; line: number }
      iteration: { index: number } | null
      status: string
      forEach?: { item: string }
    }>
    expect(
      steps.map((s) => [s.stage ?? 'steps', s.step.line, s.iteration?.index ?? null, s.status])
    ).toEqual([
      ['setup', 3, null, 'pass'],
      ['steps', 8, 1, 'pass'],
      ['steps', 8, 2, 'skipped'],
      ['teardown', 14, null, 'pass'],
      ['teardown', 14, null, 'pass']
    ])
    expect(steps.map((s) => s.forEach?.item ?? null).slice(3)).toEqual(['r1', 'r2'])

    const listed = await gta(root, 'get')
    expect(listed.out).toContain(
      'broken broken, setup step 1: use: nope — there is no nope.yml in requests/'
    )
  })

  it('runs setup and teardown around the steps tags pick, each at its own place in the file', async () => {
    const root = await project({
      'collections/tagged.yml': [
        'id: tagged',
        'stepTags: true',
        'setup:',
        '  - name: grant',
        "    POST: '{{baseUrl}}/ok/grant'",
        'steps:',
        '  - name: slow one',
        "    GET: '{{baseUrl}}/ok/slow'",
        '    tags: [slow]',
        '  - name: quick one',
        "    GET: '{{baseUrl}}/ok/quick'",
        '    tags: [quick]',
        'teardown:',
        '  - name: revoke',
        "    DELETE: '{{baseUrl}}/ok/grant'",
        ''
      ].join('\n')
    })
    const json = JSON.parse((await gta(root, 'all', '--json', '--tags', 'quick')).out)
    const steps = json.collections[0].steps as Array<{
      stage?: string
      step: { index: number; line: number }
    }>
    expect(steps.map((s) => [s.stage ?? 'steps', s.step.index, s.step.line])).toEqual([
      ['setup', 0, 4],
      ['steps', 1, 10],
      ['teardown', 0, 14]
    ])
  })

  it('names a failing request by the named use step that ran it', async () => {
    const root = await project({
      'requests/check.yml': [
        'id: check',
        'params: {}',
        'steps:',
        '  - name: first',
        "    GET: '{{baseUrl}}/ok'",
        '  - name: second',
        "    GET: '{{baseUrl}}/fail'",
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(200)',
        ''
      ].join('\n'),
      'collections/health.yml': 'id: health\nsteps:\n  - use: check\n    name: health check\n'
    })
    const { code, out } = await gta(root, 'health')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain('✗ health check › second (check 2/2) 500')

    const json = JSON.parse((await gta(root, 'health', '--json')).out)
    expect(json.collections[0].steps.map((step: { use: unknown }) => step.use)).toEqual([
      { set: 'check', name: 'health check', child: 0, of: 2 },
      { set: 'check', name: 'health check', child: 1, of: 2 }
    ])
  })

  it('writes a JUnit report when asked, beside the project by default', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok', '/fail']),
      'collections/b.yml': collection('b', ['/ok'])
    })
    const { code, out } = await gta(root, 'all', '--generateJUnitResults')
    expect(code).toBe(EXIT.failed)
    const file = path.join(await fs.realpath(root), 'test-results', 'junit', 'junit.xml')
    expect(out).toContain(`JUnit:        ${file}`)
    const xml = await fs.readFile(file, 'utf8')
    expect(xml).toContain('tests="3" failures="1" errors="0" skipped="0"')
    // In the order selected, whichever finished first.
    expect(xml.indexOf('<testsuite name="a"')).toBeLessThan(xml.indexOf('<testsuite name="b"'))
  })

  it('writes the report where testResultsBasePath says, absolute or relative', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    await gta(root, 'all', '--generateJUnitResults', '--testResultsBasePath', 'out/ci')
    await expect(fs.stat(path.join(root, 'out', 'ci', 'junit', 'junit.xml'))).resolves.toBeTruthy()
    // Written on Windows, the same folder everywhere.
    await gta(root, 'all', '--generateJUnitResults', '--testResultsBasePath', 'out\\win')
    await expect(fs.stat(path.join(root, 'out', 'win', 'junit', 'junit.xml'))).resolves.toBeTruthy()

    const elsewhere = await makeProject({})
    roots.push(elsewhere)
    await gta(root, 'all', '--generateJUnitResults', '--testResultsBasePath', elsewhere)
    await expect(fs.stat(path.join(elsewhere, 'junit', 'junit.xml'))).resolves.toBeTruthy()
  })

  it('writes a summary page and a page per collection, and opens the summary when asked', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok', '/fail']),
      'collections/checkout/sessions.yml': collection('sessions', ['/ok'])
    })
    opened.length = 0
    const written = await gta(root, 'all', '--generateHtmlResults')
    const html = path.join(await fs.realpath(root), 'test-results', 'html')
    const summary = path.join(html, 'summary.html')
    expect(written.out).toContain(`HTML:         ${summary}`)
    expect(await fs.readFile(summary, 'utf8')).toContain('<title>FAILED · ')
    expect(await fs.readFile(path.join(html, 'a.html'), 'utf8')).toContain(
      '<title>FAILED · a · gta'
    )
    // Named by id alone: ids are unique, so the directory is not needed.
    expect(await fs.readFile(path.join(html, 'sessions.html'), 'utf8')).toContain(
      '<title>PASSED · sessions · gta'
    )
    expect(opened).toEqual([])

    // Opening implies writing it.
    await gta(root, 'all', '--autoOpenTestResultHtml')
    expect(opened).toEqual([summary])
  })

  it('empties the HTML folder before a run, so no old page is left behind', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok']),
      'collections/b.yml': collection('b', ['/ok'])
    })
    const html = path.join(root, 'test-results', 'html')
    await gta(root, 'all', '--generateHtmlResults')
    await expect(fs.stat(path.join(html, 'b.html'))).resolves.toBeTruthy()
    await gta(root, 'a.yml', '--generateHtmlResults')
    expect((await fs.readdir(html)).sort()).toEqual(['a.html', 'summary.html'])
  })

  it('deletes the test results folder before every run', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    const results = path.join(root, 'test-results')
    await gta(root, 'all', '--generateJUnitResults', '--generateHtmlResults')
    expect((await fs.readdir(results)).sort()).toEqual(['html', 'junit'])
    // A run asked for no reports leaves none from before behind.
    await gta(root, 'all')
    await expect(fs.stat(results)).rejects.toThrow()
  })

  it('will not delete a test results folder holding files it did not write, and runs nothing', async () => {
    for (const mine of [
      'test-results/notes.txt',
      'test-results/html/mine.txt',
      'test-results/junit/other.xml'
    ]) {
      const root = await project({
        'collections/a.yml': collection('a', ['/ok']),
        [mine]: 'keep me'
      })
      const { code, out, err } = await gta(root, 'all', '--generateHtmlResults')
      expect(code).toBe(EXIT.unusable)
      expect(err).toContain('holds files gta did not write')
      expect(out).not.toContain('Collections:  1 total')
      expect(await fs.readFile(path.join(root, mine), 'utf8')).toBe('keep me')
    }
  })

  it('will not delete a test results folder that holds the project', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    for (const place of ['.', '..']) {
      const { code, err } = await gta(root, 'all', '--testResultsBasePath', place)
      expect(code).toBe(EXIT.unusable)
      expect(err).toContain('which holds the project')
    }
    await expect(fs.stat(path.join(root, 'collections', 'a.yml'))).resolves.toBeTruthy()
  })

  it('keeps secrets out of the console and every report', async () => {
    const root = await project({
      'environments/local.yml': `name: local\nvars:\n  baseUrl: ${server.origin}\n  token: { secret: true }\n`,
      'collections/a.yml': [
        'id: a',
        'steps:',
        "  - GET: '{{baseUrl}}/fail?t={{token}}'",
        '    tests: |',
        "      console.log('token is', gta.get('token'))",
        '      gta.expectResponseStatusCodeToBe(200)'
      ].join('\n')
    })
    const out: string[] = []
    // Runs read secrets from the process environment, as a worker inherits it.
    process.env.token = 'hunter2-secret'
    const code = await main(['all', '--generateHtmlResults', '--generateJUnitResults'], {
      cwd: root,
      env: {},
      out: (line) => out.push(line),
      err: (line) => out.push(line),
      color: false,
      runner: () => inProcessRunner,
      open: () => {}
    }).finally(() => delete process.env.token)
    expect(code).toBe(EXIT.failed)
    const html = await fs.readFile(path.join(root, 'test-results', 'html', 'a.html'), 'utf8')
    const xml = await fs.readFile(path.join(root, 'test-results', 'junit', 'junit.xml'), 'utf8')
    for (const text of [out.join('\n'), html, xml]) expect(text).not.toContain('hunter2-secret')
    expect(html).toContain('/fail?t=[secret: token]')
    expect(html).toContain('token is [secret: token]')
  })

  it('prints the run as JSON with --json, and nothing else on stdout', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok', '/fail']),
      'collections/b.yml': collection('b', ['/ok'])
    })
    const { code, out } = await gta(root, 'all', '--json')
    expect(code).toBe(EXIT.failed)
    const report = JSON.parse(out)
    expect(report).toMatchObject({
      formatVersion: 1,
      tool: { name: 'gta' },
      run: { result: 'failed', environment: 'local' },
      totals: { collections: { total: 2, passed: 1, failed: 1 } },
      reports: {}
    })
    const a = report.collections.find((c: { id: string }) => c.id === 'a')
    expect(a).toMatchObject({ file: 'collections/a.yml', status: 'failed', error: null })
    // Each step says where it is, so a failure leads to the YAML behind it.
    expect(a.steps.map((s: { step: unknown; status: string }) => [s.step, s.status])).toEqual([
      [{ index: 0, line: 3 }, 'pass'],
      [{ index: 1, line: 7 }, 'fail']
    ])
    expect(a.steps[1].assertions[0]).toMatchObject({
      status: 'fail',
      expected: 'is 200',
      actual: '500'
    })
  })

  it('lists with get --json, and prints errors as JSON too', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok'], 'tags: [smoke]'),
      'collections/checkout/b.yml': collection('b', ['/ok', '/ok'])
    })
    const listed = JSON.parse((await gta(root, 'get', '--json')).out)
    expect(listed.collections).toEqual([
      {
        id: 'a',
        file: 'collections/a.yml',
        directory: null,
        steps: [0],
        stepCount: 1,
        dataFile: null,
        tags: ['smoke'],
        broken: null
      },
      {
        id: 'b',
        file: 'collections/checkout/b.yml',
        directory: 'checkout',
        steps: [0, 1],
        stepCount: 2,
        dataFile: null,
        tags: [],
        broken: null
      }
    ])
    const failed = await gta(root, 'nope', '--json')
    expect(failed.code).toBe(EXIT.unusable)
    expect(JSON.parse(failed.out)).toEqual({
      formatVersion: 1,
      error: { message: expect.stringContaining('"nope"'), exitCode: 2 }
    })
  })

  it('writes the JSON report to json/results.json, naming every report written', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    const real = await fs.realpath(root)
    const { out } = await gta(root, 'all', '--generateJsonResults', '--generateJUnitResults')
    const file = path.join(real, 'test-results', 'json', 'results.json')
    expect(out).toContain(`JSON:         ${file}`)
    const report = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(report.reports).toEqual({
      junit: path.join(real, 'test-results', 'junit', 'junit.xml'),
      json: file
    })
    // Deleted before the next run like the other reports' folders, not refused.
    const again = await gta(root, 'all', '--generateJsonResults')
    expect(again.code).toBe(EXIT.passed)
  })

  it('runs a collection once per row of its data file, naming each iteration', async () => {
    const root = await project({
      'collections/users.yml': [
        'id: users',
        'steps:',
        '  - name: get user',
        "    GET: '{{baseUrl}}/{{path}}'",
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(200)'
      ].join('\n'),
      'collections/users.csv': 'path,iterationLabel\nok,Happy path\nfail,Server error\nok,\n'
    })
    const listed = await gta(root, 'get')
    expect(listed.out).toMatch(/1 {2}users +1 +3/)

    const ran = await gta(root, 'all')
    expect(ran.code).toBe(EXIT.failed)
    expect(ran.out).toContain('Steps:        3 total, 2 passed, 1 failed')
    expect(ran.out).toContain('✗ Iteration 2 (Server error) - get user 500')

    const json = JSON.parse((await gta(root, 'all', '--json')).out)
    const [users] = json.collections
    expect(users.dataFile).toEqual({ file: 'collections/users.csv', rows: 3 })
    expect(users.steps.map((s: { iteration: unknown }) => s.iteration)).toEqual([
      { index: 1, of: 3, label: 'Happy path' },
      { index: 2, of: 3, label: 'Server error' },
      { index: 3, of: 3, label: null }
    ])
  })

  it('stops every row still to come when told to bail', async () => {
    const root = await project({
      'collections/users.yml': collection('users', ['/{{path}}', '/ok']),
      'collections/users.csv': 'path\nfail\nok\nok\n'
    })
    const { out } = await gta(root, 'all', '--bail')
    expect(out).toContain('Steps:        6 total, 0 passed, 1 failed, 0 errored, 5 skipped')
  })

  it('will not run a collection whose data file will not read', async () => {
    const root = await project({
      'collections/users.yml': collection('users', ['/ok']),
      'collections/users.csv': 'path\n'
    })
    const { code, out } = await gta(root, 'all')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain('users.csv: no rows')
  })

  describe('feature flags', () => {
    const node = JSON.stringify(process.execPath)
    const flagged = async (flagsBlock: string) =>
      project({
        'environments/local.yml': `name: local\nvars:\n  baseUrl: ${server.origin}\n${flagsBlock}`,
        'flags.cjs': "console.log(JSON.stringify({ newCheckout: true, pricing: 'v2' }))",
        'collections/checkout.yml': [
          'id: checkout',
          'steps:',
          '  - name: new total',
          "    GET: '{{baseUrl}}/ok'",
          '    flags: { newCheckout: true }',
          '  - name: old total',
          "    GET: '{{baseUrl}}/fail'",
          '    flags: { newCheckout: false }',
          '    tests: |',
          '      gta.expectResponseStatusCodeToBe(200)'
        ].join('\n'),
        'collections/pricing.yml': [
          'id: pricing',
          'flags: { pricing: v1 }',
          'steps:',
          "  - GET: '{{baseUrl}}/fail'",
          '    tests: |',
          '      gta.expectResponseStatusCodeToBe(200)'
        ].join('\n')
      })

    it('runs the environment’s command before the run, and skips what its flags rule out', async () => {
      const root = await flagged(
        `flags:\n  command: '${node} flags.cjs'\n  values:\n    newCheckout: false\n`
      )
      const { code, out } = await gta(root, 'all')
      expect(code).toBe(EXIT.passed)
      expect(out).toMatch(/Flags: +newCheckout=true, pricing=v2 \(from .*flags\.cjs\)/)
      expect(out).toContain('Steps:        3 total, 1 passed, 0 failed, 0 errored, 2 skipped')
      expect(out).toMatch(/pricing .* skipped/)

      const json = JSON.parse((await gta(root, 'all', '--json')).out)
      expect(json.run.flags).toMatchObject({
        values: { newCheckout: true, pricing: 'v2' },
        sources: { newCheckout: 'command', pricing: 'command' }
      })
      const checkout = json.collections.find((c: { id: string }) => c.id === 'checkout')
      expect(checkout.steps[1]).toMatchObject({
        status: 'skipped',
        skipped: { reason: 'feature flag newCheckout is on' }
      })
      expect(json.collections.find((c: { id: string }) => c.id === 'pricing').status).toBe(
        'skipped'
      )
    })

    it('lets --flag and GTA_FLAG_ override what the environment says', async () => {
      const root = await flagged('flags:\n  values:\n    newCheckout: true\n    pricing: v2\n')
      const { code, out } = await gta(root, 'checkout', '--flag', 'newCheckout=false')
      expect(code).toBe(EXIT.failed)
      expect(out).toContain('✗ old total 500')
      expect(out).toContain('(1 overridden)')

      const viaEnv = await main(['pricing'], {
        cwd: root,
        env: { GTA_FLAG_pricing: 'v1' },
        out: () => {},
        err: () => {},
        color: false,
        runner: () => inProcessRunner,
        open: () => {}
      })
      expect(viaEnv).toBe(EXIT.failed)
    })

    it('stops before running anything when the command fails', async () => {
      const root = await flagged(`flags:\n  command: '${node} -e "process.exit(4)"'\n`)
      const { code, err } = await gta(root, 'all')
      expect(code).toBe(EXIT.unusable)
      expect(err).toContain('exited with code 4')
    })

    it('reports a flag the environment does not have as an error', async () => {
      const root = await flagged('flags:\n  values:\n    newCheckout: true\n')
      const { code, out } = await gta(root, 'pricing')
      expect(code).toBe(EXIT.failed)
      expect(out).toContain('flags error: feature flag pricing is not known')
    })
  })

  it('fails the run when the report cannot be written', async () => {
    const root = await project({
      'collections/a.yml': collection('a', ['/ok']),
      // A file where the test-results directory should be.
      'test-results': 'not a directory'
    })
    const { code, err } = await gta(root, 'all', '--generateJUnitResults')
    expect(code).toBe(EXIT.unusable)
    expect(err).toContain('Could not write the JUnit report')
  })

  it('refuses an environmentType the project does not have', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    const { code, err } = await gta(root, 'all', '--environmentType', 'prod')
    expect(code).toBe(EXIT.unusable)
    expect(err).toContain('there is no environment called "prod". This project has: local')
  })

  it('uses the global project’s environments', async () => {
    const root = await project({
      'service/project.yml': 'uses: ../shared\n',
      'service/settings.yml': 'environmentType: stage\n',
      'service/collections/a.yml': collection('a', ['/ok']),
      'shared/project.yml': 'name: shared\n',
      'shared/environments/stage.yml': `name: stage\nvars:\n  baseUrl: ${server.origin}\n`
    })
    const { code, out } = await gta(path.join(root, 'service'), 'all')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Environment:  stage')
  })

  it('runs with the global project’s settings.yml under its own, and get says which is which', async () => {
    const root = await project({
      'service/project.yml': 'uses: ../shared\n',
      'service/settings.yml': 'limitConcurrency: 3\n',
      'service/collections/a.yml': collection('a', ['/ok']),
      'shared/project.yml': 'name: shared\n',
      'shared/settings.yml': 'environmentType: stage\nlimitConcurrency: 1\n',
      'shared/environments/stage.yml': `name: stage\nvars:\n  baseUrl: ${server.origin}\n`
    })
    const service = path.join(root, 'service')
    const { code, out } = await gta(service, 'all')
    expect(code).toBe(EXIT.passed)
    expect(out).toContain('Environment:  stage')
    expect(out).toContain('Concurrency:  3')

    const listed = await gta(service, 'get', '--bail')
    expect(listed.out).toMatch(/Settings: +environmentType: stage +\.\.\/shared\/settings\.yml/)
    expect(listed.out).toMatch(/ {14}limitConcurrency: 3 +settings\.yml/)
    expect(listed.out).toMatch(/ {14}bail: true +--bail/)
    expect(listed.out).not.toContain('timeoutCollection')

    const json = JSON.parse((await gta(service, 'get', '--json')).out)
    expect(json.settings.values).toMatchObject({ environmentType: 'stage', limitConcurrency: 3 })
    expect(json.settings.sources).toMatchObject({
      environmentType: '../shared/settings.yml',
      limitConcurrency: 'settings.yml',
      bail: 'default'
    })

    await fs.writeFile(path.join(root, 'shared/settings.yml'), 'environmentType: prod\n')
    const missing = await gta(service, 'all')
    expect(missing.code).toBe(EXIT.unusable)
    expect(missing.err).toContain(
      'environmentType (from ../shared/settings.yml): there is no environment called "prod"'
    )
  })

  it('says when every setting is its default', async () => {
    const root = await project({
      'settings.yml': '',
      'collections/a.yml': collection('a', ['/ok'])
    })
    const { out } = await gta(root, 'get')
    expect(out).toContain('Settings:     all defaults')
  })

  it('trusts a server signed by the CA in tls.ca, and says so', async () => {
    const tls = fileURLToPath(new URL('../../../packages/core/test-fixtures/tls/', import.meta.url))
    const secure = https.createServer(
      {
        cert: await fs.readFile(path.join(tls, 'server.pem')),
        key: await fs.readFile(path.join(tls, 'server-key.pem'))
      },
      (_req, res) => res.end('ok')
    )
    await new Promise<void>((resolve) => secure.listen(0, '127.0.0.1', resolve))
    try {
      const origin = `https://localhost:${(secure.address() as AddressInfo).port}`
      const root = await project({
        'environments/local.yml': `name: local\nvars:\n  baseUrl: ${origin}\n`,
        'collections/a.yml': collection('a', ['/ok']),
        'certs/local-ca.pem': await fs.readFile(path.join(tls, 'ca.pem'), 'utf8')
      })
      const untrusted = await gta(root, 'all')
      expect(untrusted.code).toBe(EXIT.failed)
      expect(untrusted.out).toContain('add its certificate to tls.ca in project.yml')

      await fs.writeFile(path.join(root, 'project.yml'), 'tls:\n  ca: [certs/local-ca.pem]\n')
      const { code, out } = await gta(root, 'all')
      expect(code).toBe(EXIT.passed)
      expect(out).toContain('CA files:     certs/local-ca.pem (Gravity Test CA)')
    } finally {
      secure.closeAllConnections()
      await new Promise<void>((resolve) => secure.close(() => resolve()))
    }
  })

  it('refuses to run while a tls.ca file cannot be used', async () => {
    const root = await project({
      'project.yml': 'tls:\n  ca: [certs/gone.pem]\n',
      'collections/a.yml': collection('a', ['/ok'])
    })
    const { code, err } = await gta(root, 'all')
    expect(code).toBe(EXIT.unusable)
    expect(err).toContain('A certificate in tls.ca cannot be used:')
    expect(err).toContain('certs/gone.pem: no such file (tls.ca in project.yml)')
  })

  it('uploads files from the project folder, and names one it cannot read, run or not', async () => {
    const upload = (file: string) =>
      [
        'id: upload',
        'steps:',
        "  - POST: '{{baseUrl}}/ok'",
        '    body:',
        '      multipart:',
        '        caption: hello',
        `        avatar: { file: ${file} }`,
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(200)'
      ].join('\n')
    const root = await project({
      'files/avatar.png': 'not really a png',
      'collections/checkout/upload.yml': upload('files/avatar.png')
    })
    expect((await gta(root, 'all')).code).toBe(EXIT.passed)
    expect((await gta(root, 'get')).code).toBe(EXIT.passed)

    await fs.writeFile(path.join(root, 'collections/checkout/upload.yml'), upload('files/gone.png'))
    const { code, out } = await gta(root, 'all')
    expect(code).toBe(EXIT.failed)
    expect(out).toContain(
      'body error: multipart field avatar: files/gone.png — no such file in the project folder'
    )
    // gta get finds it without a run.
    const listed = await gta(root, 'get')
    expect(listed.code).toBe(EXIT.failed)
    expect(listed.out).toContain(
      'broken upload, step 1: multipart field avatar: files/gone.png — no such file in the project folder'
    )
  })

  it('fails when nothing matches', async () => {
    const root = await project({ 'collections/a.yml': collection('a', ['/ok']) })
    const { code, err } = await gta(root, 'all', '--tags', 'nothing')
    expect(code).toBe(EXIT.failed)
    expect(err).toContain('Nothing to run')
  })
})
