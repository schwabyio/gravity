import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collection, makeProject, startServer } from './testProject.js'

/**
 * The bundle as installed: dist/gta.js, each collection in a worker thread.
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

  it('ships SPEC.md and the licenses of the packages it bundles', async () => {
    const dist = path.join(cliRoot, 'dist')
    const notices = await fs.readFile(path.join(dist, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
    for (const name of ['undici', 'yaml', 'zod']) {
      expect(notices).toMatch(new RegExp(`^${name} \\d+\\.\\d+\\.\\d+ \\(`, 'm'))
    }
    const spec = await fs.readFile(path.join(dist, 'SPEC.md'), 'utf8')
    expect(spec).toMatch(/^# The Gravity file format/)
  })
})
