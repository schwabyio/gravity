import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, makeProject, startServer } from './testProject.js'

/**
 * The bundle as installed: dist/gta.js, each collection in a worker thread,
 * and the library, imported by its package name and run under Playwright.
 * Everything else is tested in process; this is what proves the bundle and the
 * workers hold together.
 */
const exec = promisify(execFile)
const cliRoot = fileURLToPath(new URL('..', import.meta.url))
const bin = path.join(cliRoot, 'dist', 'gta.js')

let server: Awaited<ReturnType<typeof startServer>>
let root: string

beforeAll(async () => {
  await exec(process.execPath, ['build.mjs'], { cwd: cliRoot })
  server = await startServer()
  root = await makeProject({
    'settings.yml': 'environmentType: local\nlimitConcurrency: 3\n',
    'environments/local.yml': `name: local\nvars:\n  baseUrl: ${server.origin}\n`,
    'collections/one.yml': collection('one', ['/ok', '/ok']),
    'collections/two.yml': collection('two', ['/ok']),
    'collections/slow.yml': collection('slow', ['/slow'])
  })
}, 30_000)

afterAll(async () => {
  await server.close()
  await fs.rm(root, { recursive: true, force: true })
})

async function gta(...argv: string[]) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [bin, ...argv], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: undefined }
    })
    return { code: 0, stdout, stderr }
  } catch (cause) {
    const failure = cause as { code: number; stdout: string; stderr: string }
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr }
  }
}

describe('dist/gta.js', () => {
  it('runs collections in worker threads', async () => {
    const { code, stdout } = await gta('one,two')
    expect(code).toBe(0)
    expect(stdout).toContain('Collections:  2 total, 2 passed, 0 failed')
    expect(stdout).toContain('Steps:        3 total, 3 passed')
  })

  // `slow` alone, which never gets an answer. The timer starts with the thread, and
  // on the Windows CI runner a one-step collection of local requests took over
  // 500 ms, so no collection that should pass may race it.
  it('stops a collection at timeoutCollection and fails the run', async () => {
    const { code, stdout } = await gta('slow', '--timeoutCollection', '500')
    expect(code).toBe(1)
    expect(stdout).toContain('Timed out after 500 ms (timeoutCollection)')
    expect(stdout).toContain('Collections:  1 total, 0 passed, 1 failed')
  })

  it('writes a JUnit report of a timed-out run', async () => {
    const { code } = await gta('slow', '--timeoutCollection', '500', '--generateJUnitResults')
    expect(code).toBe(1)
    const xml = await fs.readFile(path.join(root, 'test-results', 'junit', 'junit.xml'), 'utf8')
    expect(xml).toContain('tests="1" failures="0" errors="1" skipped="0"')
    expect(xml).toContain('<testsuite name="slow" tests="1" failures="0" errors="1"')
  })

  it('exits 2 when it cannot run at all', async () => {
    const { code, stderr } = await gta('all', '--limitConcurrency', 'lots')
    expect(code).toBe(2)
    expect(stderr).toContain('limitConcurrency (from --limitConcurrency)')
  })

  it('ships SPEC.md, FUNCTIONS.md and the licenses of the packages it bundles', async () => {
    const dist = path.join(cliRoot, 'dist')
    const notices = await fs.readFile(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const name of ['undici', 'yaml', 'zod']) {
      expect(notices).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(`, 'm'))
    }
    const spec = await fs.readFile(path.join(dist, 'SPEC.md'), 'utf8')
    expect(spec).toMatch(/^# The Gravity file format/)
    const functions = await fs.readFile(path.join(dist, 'FUNCTIONS.md'), 'utf8')
    expect(functions).toMatch(/^# The `gta` functions/)
  })
})

/** What `dump.mjs`, a reporter, records of each Playwright test. */
interface Step {
  title: string
  location?: { file: string; line: number; column: number }
  error?: string
  annotations: Array<{ type: string; description?: string }>
  attachments: Array<{ name: string; body?: string }>
  steps: Step[]
}
interface TestRecord {
  title: string
  project: string
  status: string
  annotations: Array<{ type: string }>
  errors: Array<{ message: string; location?: { file: string; line: number; column: number } }>
  steps: Step[]
}

/** A reporter that writes down each test's steps — locations, annotations and attachments too. */
const DUMP = `import fs from 'node:fs'
import path from 'node:path'

const stepOf = (step) => ({
  title: step.title,
  location: step.location,
  error: step.error?.message,
  annotations: step.annotations,
  attachments: step.attachments.map((a) => ({ name: a.name, body: a.body?.toString('utf8') })),
  steps: step.steps.filter((s) => s.category === 'test.step').map(stepOf)
})

export default class Dump {
  tests = []
  onBegin(config) {
    this.file = path.join(path.dirname(config.configFile), 'report.json')
  }
  onTestEnd(test, result) {
    this.tests.push({
      title: test.title,
      project: test.parent.project()?.name,
      status: result.status,
      annotations: test.annotations,
      errors: result.errors.map((e) => ({ message: e.message, location: e.location })),
      steps: result.steps.filter((s) => s.category === 'test.step').map(stepOf)
    })
  }
  onEnd() {
    fs.writeFileSync(this.file, JSON.stringify(this.tests))
  }
  printsToStdio() {
    return false
  }
}
`

const lines = (...text: string[]): string => [...text, ''].join('\n')

/** Each step's title, time left out as it changes from run to run, with the steps inside it. */
const titles = (steps: Step[]): unknown[] =>
  steps.map((step) =>
    step.steps.length > 0
      ? { [step.title]: titles(step.steps) }
      : step.title.replace(/ · \d+ ms$/, ' · ms')
  )

describe('the library in dist/', () => {
  /**
   * A project that holds its Playwright tests, imported as a project would:
   * by package name. Its folder's name has a space, as a Windows user's often does.
   */
  let dir: string
  const SPEC = lines(
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "import { fileURLToPath } from 'node:url'",
    "import { test, expect } from '@schwabyio/gta/playwright'",
    '',
    'const here = path.dirname(fileURLToPath(import.meta.url))',
    '',
    "test('logs in, then checks out with what it saved', async ({ gta }) => {",
    "  const login = await gta.use('login', { user: 'ann' })",
    "  expect(login.values.seen).toBe('/ok/ann')",
    "  await gta.run('checkout', { vars: login.values })",
    '})',
    '',
    "test('fails at the line that ran a failing collection', async ({ gta }) => {",
    "  await gta.run('broken')",
    "  throw new Error('not reached')",
    '})',
    '',
    "test('goes on after a soft failure', async ({ gta }) => {",
    "  await gta.run('broken', { soft: true })",
    "  test.info().annotations.push({ type: 'reached' })",
    '})',
    '',
    '// Torn down after gta, which was set up after it: it logs when the test has let go.',
    'const timed = test.extend<{ letGo: void }>({',
    '  letGo: [',
    '    async ({}, use) => {',
    '      await use()',
    "      fs.appendFileSync(path.join(here, 'stopped.log'), 'test let go\\n')",
    '    },',
    '    { auto: true }',
    '  ]',
    '})',
    '',
    "timed('stops a run still going when the test times out', async ({ gta }) => {",
    '  // From the start of the test, opening the project too: room for a slow machine.',
    '  test.setTimeout(2000)',
    "  await gta.run('sleepy', {",
    '    onResult: (result) =>',
    "      fs.appendFileSync(path.join(here, 'stopped.log'), `${result.error?.message}\\n`)",
    '  })',
    '})'
  )
  /** The line of the spec that says this, from 1. */
  const lineOf = (text: string) => SPEC.split('\n').findIndex((line) => line.includes(text)) + 1

  beforeAll(async () => {
    // Inside the repo, where `@schwabyio/gta` resolves to this package, and gitignored.
    await fs.mkdir(path.join(cliRoot, 'test-results'), { recursive: true })
    dir = await fs.mkdtemp(path.join(cliRoot, 'test-results', 'playwright run-'))
    const files: Record<string, string> = {
      'settings.yml': 'environmentType: local\n',
      'environments/local.yml': `vars:\n  baseUrl: ${server.origin}\n`,
      'requests/login.yml': lines(
        'id: login',
        'params:',
        '  user: { required: true }',
        'steps:',
        '  - name: log in',
        "    GET: '{{baseUrl}}/ok/{{params.user}}'",
        '    tests: |',
        '      gta.expectResponseStatusCodeToBe(200)',
        "      gta.expectResponseBodyToHaveProperty('url', 'seen', 'setAsCollectionVariable')"
      ),
      'collections/checkout.yml': lines(
        'id: checkout',
        'steps:',
        '  - name: get order',
        "    GET: '{{baseUrl}}/ok{{seen}}'",
        '    tests: gta.expectResponseStatusCodeToBe(200)',
        '  - name: not today',
        "    GET: '{{baseUrl}}/ok'",
        '    before:',
        "      script: gta.skip('not today')"
      ),
      'collections/broken.yml': collection('broken', ['/ok', '/fail']),
      // Still in its script when the test times out, so it takes a while to stop.
      'collections/sleepy.yml': lines(
        'id: sleepy',
        'steps:',
        "  - GET: '{{baseUrl}}/ok'",
        '    before:',
        '      script: await new Promise((resolve) => setTimeout(resolve, 3000))'
      ),
      // A second project, which the `options` tests name, with environments of its own.
      'other/settings.yml': 'environmentType: alpha\n',
      'other/environments/alpha.yml': lines(
        'vars:',
        `  baseUrl: ${server.origin}`,
        '  stage: alpha',
        'flags:',
        '  values: { newCheckout: false }'
      ),
      'other/environments/beta.yml': lines(
        'vars:',
        `  baseUrl: ${server.origin}`,
        '  stage: beta',
        'flags:',
        '  values: { newCheckout: false }'
      ),
      'other/collections/flagged.yml': lines(
        'id: flagged',
        'flags: { newCheckout: true }',
        'steps:',
        "  - GET: '{{baseUrl}}/ok/{{stage}}'"
      ),
      'dump.mjs': DUMP,
      'playwright.config.ts': lines(
        "import { defineConfig } from '@playwright/test'",
        "import type { GravityConfig } from '@schwabyio/gta/playwright'",
        '',
        'export default defineConfig<{}, GravityConfig>({',
        "  testDir: '.',",
        "  outputDir: 'out',",
        '  workers: 1,',
        "  reporter: [['./dump.mjs']],",
        '  projects: [',
        '    // No project named: the folder this file is in.',
        "    { name: 'defaults', testMatch: 'gta.spec.ts' },",
        '    {',
        "      name: 'options',",
        "      testMatch: 'options.spec.ts',",
        "      use: { gravity: { project: 'other', environment: 'beta', flags: { newCheckout: true } } }",
        '    }',
        '  ]',
        '})'
      ),
      'gta.spec.ts': SPEC,
      'options.spec.ts': lines(
        "import { test, expect } from '@schwabyio/gta/playwright'",
        '',
        "test('takes the project, environment and flags from use: { gravity }', async ({ gta }) => {",
        "  expect(gta.project.environment).toBe('beta')",
        "  const outcome = await gta.run('flagged')",
        "  expect(outcome.summary.results[0]?.status).toBe('pass')",
        '  expect(outcome.summary.results[0]?.request.url).toMatch(/\\/ok\\/beta$/)',
        '})'
      ),
      'library.ts': lines(
        "import { openProject, type RunOutcome, type VarValue } from '@schwabyio/gta'",
        "import { test, type Gta } from '@schwabyio/gta/playwright'",
        '',
        "const project = await openProject('.', { environment: 'local', flags: { a: true } })",
        "const outcome: RunOutcome = await project.run('checkout', { steps: ['get order', 1] })",
        'const seen: VarValue | undefined = outcome.values.seen',
        'console.log(JSON.stringify({ passed: outcome.passed, seen, line: outcome.steps[0]?.line }))',
        "test('typed', async ({ gta }) => {",
        '  const fixture: Gta = gta',
        "  await fixture.use('login', { user: 'ann' }, { soft: true })",
        '})'
      )
    }
    for (const [name, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await fs.writeFile(path.join(dir, name), text)
    }
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('runs collections from code, imported as @schwabyio/gta', async () => {
    const script = [
      "import { openProject } from '@schwabyio/gta'",
      "const project = await openProject('.')",
      "const login = await project.use('login', { user: 'bob' })",
      "const broken = await project.run('broken')",
      'console.log(JSON.stringify({ values: login.values, passed: broken.passed, failures: broken.failures }))'
    ].join('\n')
    const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', script], {
      cwd: dir
    })
    expect(JSON.parse(stdout)).toEqual({
      values: { seen: '/ok/bob' },
      passed: false,
      failures: expect.stringContaining('broken\n  ✗ get /fail 500')
    })
  })

  it('declares its types in files that stand alone', () => {
    const program = ts.createProgram([path.join(dir, 'library.ts')], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      // The published .d.ts files are checked too, not taken on trust.
      skipLibCheck: false,
      types: ['node']
    })
    const problems = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
    expect(problems).toEqual([])
  })

  describe('under Playwright', () => {
    let tests: TestRecord[]
    /** The test called this, with its steps. */
    const record = (title: string): TestRecord => {
      const found = tests.find((t) => t.title === title)
      if (!found) throw new Error(`Playwright ran no test called "${title}"`)
      return found
    }

    beforeAll(async () => {
      const cli = createRequire(import.meta.url).resolve('@playwright/test/cli')
      // Exits 1, since some of these tests fail on purpose; the report says how.
      await exec(process.execPath, [cli, 'test', '-c', path.join(dir, 'playwright.config.ts')], {
        cwd: dir
      }).catch(() => {})
      tests = JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8')) as TestRecord[]
    }, 60_000)

    it('reports each run, and each request inside it, as steps', () => {
      const passing = record('logs in, then checks out with what it saved')
      expect(passing.status).toBe('passed')
      expect(titles(passing.steps)).toEqual([
        { 'gta use login': ['log in · 200 · ms'] },
        { 'gta checkout': ['get order · 200 · ms', 'not today · skipped'] }
      ])
    })

    it('places a run at the line that called it, and a request at its step in the YAML', () => {
      const [login, checkout] = record('logs in, then checks out with what it saved').steps
      // The folder's name has a space: the line is found all the same.
      expect(login!.location).toEqual({
        file: path.join(dir, 'gta.spec.ts'),
        line: lineOf("await gta.use('login'"),
        column: 27
      })
      expect(login!.steps[0]!.location).toEqual({
        file: path.join(dir, 'requests', 'login.yml'),
        line: 5,
        column: 1
      })
      expect(checkout!.steps.map((step) => step.location)).toEqual([
        { file: path.join(dir, 'collections', 'checkout.yml'), line: 3, column: 1 },
        { file: path.join(dir, 'collections', 'checkout.yml'), line: 6, column: 1 }
      ])
    })

    it('attaches what each request sent and received, and marks a skipped step skipped', () => {
      const [login, checkout] = record('logs in, then checks out with what it saved').steps
      const [attachment] = login!.steps[0]!.attachments
      expect(attachment!.name).toBe('request and response')
      expect(attachment!.body).toContain(`GET ${server.origin}/ok/ann\n`)
      expect(attachment!.body).toMatch(/\n200 OK · \d+ ms · \d+ bytes\n/)
      expect(attachment!.body).toContain('{"url":"/ok/ann","ok":true}')
      expect(attachment!.body).toContain('Checks:\n✓ Status is 200\n')

      const skipped = checkout!.steps[1]!
      expect(skipped.annotations).toMatchObject([{ type: 'skip', description: 'not today' }])
      // It sent nothing, so there is nothing to show.
      expect(skipped.attachments).toEqual([])
    })

    it('fails the test at the line that ran a failing collection, once, with what failed', () => {
      const failing = record('fails at the line that ran a failing collection')
      expect(failing.status).toBe('failed')
      expect(failing.errors).toHaveLength(1)
      const [error] = failing.errors
      expect(error!.message).toContain('gta broken: 1 of 2 steps failed')
      expect(error!.message).toContain('✗ get /fail 500')
      expect(error!.location).toEqual({
        file: path.join(dir, 'gta.spec.ts'),
        line: lineOf("await gta.run('broken')"),
        column: 13
      })
      // The failing request is marked on its own step too.
      expect(failing.steps[0]!.steps.map((step) => Boolean(step.error))).toEqual([false, true])
    })

    it('goes on after a soft failure, and fails the test at the end', () => {
      const soft = record('goes on after a soft failure')
      expect(soft.status).toBe('failed')
      expect(soft.errors).toHaveLength(1)
      expect(soft.annotations.map((a) => a.type)).toEqual(['reached'])
    })

    it('stops a run still going when the test times out, with no error of its own', async () => {
      const timedOut = record('stops a run still going when the test times out')
      expect(timedOut.status).toBe('timedOut')
      // Playwright's timeout, and nothing from the run it stopped.
      expect(timedOut.errors).toHaveLength(1)
      expect(timedOut.errors[0]!.message).toContain('Test timeout of 2000ms exceeded')
      // The run saw its request cancelled, and was waited for: nothing of it outlasts the test.
      expect(await fs.readFile(path.join(dir, 'stopped.log'), 'utf8')).toBe(
        'Request cancelled\ntest let go\n'
      )
    })

    it('opens the folder the config is in by default, and the project use: { gravity } names', () => {
      // Every test of the `defaults` project ran against the config's folder.
      expect(record('logs in, then checks out with what it saved').project).toBe('defaults')
      const options = record('takes the project, environment and flags from use: { gravity }')
      expect(options.project).toBe('options')
      expect(options.status).toBe('passed')
      expect(options.steps[0]!.steps[0]!.location?.file).toBe(
        path.join(dir, 'other', 'collections', 'flagged.yml')
      )
    })
  })
})
