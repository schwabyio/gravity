/**
 * `npm run coverage:e2e`: how much of the code the tests reach, end to end as
 * well as unit. Slow, so it is run before a release rather than on every change.
 *
 * 1. The unit tests with coverage (`npm run coverage`), into coverage/unit.
 * 2. The app built with source maps, and the end-to-end suite run with
 *    GRAVITY_COVERAGE=1: e2e/launch.ts records the main process, the run worker
 *    and the window of every app a spec launches, into coverage/e2e-data.
 * 3. Reports, by monocart-coverage-reports as for the unit tests (see
 *    mcr.config.mjs): coverage/e2e for the end-to-end tests alone, coverage/all
 *    for both together. Each has index.html and coverage-summary.json; the raw
 *    data they are made from is in coverage/raw.
 *
 * Arguments go to Playwright: `npm run coverage:e2e -- e2e/rules.spec.ts`.
 * The reports are written even when a test fails; the exit code says one did.
 * `--report-only` writes the reports again from the last run's raw data.
 */
import { spawnSync } from 'node:child_process'
import console from 'node:console'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CoverageReport } from 'monocart-coverage-reports'
import { RAW, report, sourceFilter, sourcePath } from '../../mcr.config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const coverage = path.join(repo, 'coverage')
const data = path.join(coverage, 'e2e-data')

/** Run a command to the end, its output shown; its exit code. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    // npm and npx are .cmd scripts on Windows, which only a shell runs.
    shell: process.platform === 'win32',
    ...options
  })
  return result.status ?? 1
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const reportOnly = process.argv.includes('--report-only')
let tests = 0
if (!reportOnly) {
  if (run(npm, ['run', 'coverage'], { cwd: repo }) !== 0) {
    console.error('The unit tests failed: no coverage report.')
    process.exit(1)
  }
  for (const dir of ['e2e', 'e2e-data', 'raw/e2e', 'all']) {
    fs.rmSync(path.join(coverage, dir), { recursive: true, force: true })
  }
  const env = { ...process.env, GRAVITY_COVERAGE: '1' }
  if (run(npx, ['electron-vite', 'build'], { cwd: here, env }) !== 0) process.exit(1)
  tests = run(npx, ['playwright', 'test', ...process.argv.slice(2)], { cwd: here, env })
}

// Run from the repository's root, where mcr.config.mjs's paths are.
process.chdir(repo)

// The raw data first: the report is made from it, and the merge below. What the
// specs recorded is large, and only read once: it goes when the raw data is made.
if (fs.existsSync(data)) {
  const e2e = new CoverageReport({
    name: 'Gravity end to end',
    outputDir: 'coverage/raw/e2e',
    reports: [['raw', { outputDir: 'data' }]],
    // The main process and run worker's bundles, and the window's.
    entryFilter: (entry) =>
      entry.url.includes('/out/main/') || entry.url.includes('/out/renderer/'),
    sourceFilter,
    sourcePath
  })
  const windows = path.join(data, 'renderer')
  for (const file of fs.existsSync(windows) ? fs.readdirSync(windows) : []) {
    const entries = JSON.parse(fs.readFileSync(path.join(windows, file), 'utf8'))
    // Recorded without their text, which is read back from the build the run used.
    for (const entry of entries) entry.source = fs.readFileSync(fileURLToPath(entry.url), 'utf8')
    if (entries.length > 0) await e2e.add(entries)
  }
  const node = path.join(data, 'node')
  if (fs.existsSync(node)) await e2e.addFromDir(node)
  await e2e.generate()
  fs.rmSync(data, { recursive: true, force: true })
}

// What the app is made of: the CLI is the unit tests' alone.
await report('Gravity end to end', RAW.e2e, 'coverage/e2e', [
  'packages/core/src',
  'apps/desktop/src'
])
// Both together, merged source by source.
await report('Gravity, unit and end to end', [RAW.unit, RAW.e2e], 'coverage/all')

console.log('\nReports: coverage/e2e/index.html, coverage/all/index.html')
process.exit(tests)
