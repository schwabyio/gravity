import fs from 'node:fs'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

/**
 * The app, launched for a spec. Under `npm run coverage:e2e` (GRAVITY_COVERAGE=1)
 * it also records what the spec reaches, for e2e-coverage.mjs to report: the
 * main process and the run worker through Node's NODE_V8_COVERAGE, the window
 * through Playwright. Any other time it is `electron.launch`, nothing added.
 */
export const COVERAGE = process.env['GRAVITY_COVERAGE'] === '1'

/** Where what the specs reach is recorded: coverage/e2e-data at the repository's root. */
export const RAW_COVERAGE = path.resolve(process.cwd(), '../../coverage/e2e-data')

let launched = 0

export async function launchApp(
  options: Parameters<typeof electron.launch>[0]
): Promise<ElectronApplication> {
  if (!COVERAGE) return electron.launch(options)

  const node = path.join(RAW_COVERAGE, 'node')
  const windows = path.join(RAW_COVERAGE, 'renderer')
  fs.mkdirSync(node, { recursive: true })
  fs.mkdirSync(windows, { recursive: true })
  const app = await electron.launch({
    ...options,
    env: { ...(options?.env ?? process.env), NODE_V8_COVERAGE: node }
  })

  const page = await app.firstWindow()
  await page.coverage.startJSCoverage({ resetOnNavigation: false })
  // The window loaded before recording could start: load it again, start-up and all.
  await page.reload()

  const close = app.close.bind(app)
  const name = `${process.pid}-${++launched}.json`
  app.close = async () => {
    // A spec that closed the window itself has nothing left to stop.
    const entries = await page.coverage.stopJSCoverage().catch(() => [])
    // The app's own code only; its text is read back from out/ by the report.
    const own = entries
      .filter((entry) => entry.url.includes('/out/renderer/'))
      .map(({ url, functions }) => ({ url, functions }))
    fs.writeFileSync(path.join(windows, name), JSON.stringify(own))
    return close()
  }
  return app
}
