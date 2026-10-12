import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication } from '@playwright/test'

/**
 * The app, launched for a spec. Under `npm run coverage:e2e` (GRAVITY_COVERAGE=1)
 * it also records what the spec reaches, for e2e-coverage.mjs to report: the
 * main process and the run worker through Node's NODE_V8_COVERAGE, the window
 * through Playwright. Any other time it is `electron.launch`, with closing
 * watched (`watchClosing`).
 */
export const COVERAGE = process.env['GRAVITY_COVERAGE'] === '1'

/** Where what the specs reach is recorded: coverage/e2e-data at the repository's root. */
export const RAW_COVERAGE = path.resolve(process.cwd(), '../../coverage/e2e-data')

/** How long the app has to close before the spec is told why it has not, and it is killed. */
const CLOSE_MS = 20_000

let launched = 0
let watched = 0

export async function launchApp(
  options: Parameters<typeof electron.launch>[0]
): Promise<ElectronApplication> {
  if (!COVERAGE) return watchClosing(await electron.launch(options))

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
  return watchClosing(app)
}

/**
 * Closing that cannot hang a spec: should `app.close()` not finish in
 * `CLOSE_MS`, the spec fails saying what main showed — a message box asking
 * about unsaved edits, say, which nobody will answer — and the app is killed,
 * rather than holding up the hook, then the worker, for a minute each.
 *
 * Main writes down every message box it shows, in a temporary file:
 * once closing has begun, it can no longer be asked. A spec that answers them
 * itself (`save.spec`) replaces this along with the original.
 */
async function watchClosing(app: ElectronApplication): Promise<ElectronApplication> {
  const record = path.join(os.tmpdir(), `gta-e2e-message-boxes-${process.pid}-${++watched}.txt`)
  await app.evaluate(({ dialog }, file) => {
    const fs = process.getBuiltinModule('node:fs')
    const show = dialog.showMessageBox.bind(dialog) as (...args: unknown[]) => unknown
    dialog.showMessageBox = ((...args: unknown[]) => {
      const options = args.at(-1) as { message?: string; detail?: string }
      fs.appendFileSync(file, `${[options.message, options.detail].filter(Boolean).join(' ')}\n`)
      return show(...args)
    }) as typeof dialog.showMessageBox
  }, record)
  const shown = () => {
    try {
      return fs.readFileSync(record, 'utf8').trim().split('\n')
    } catch {
      return []
    }
  }

  const close = app.close.bind(app)
  app.close = async () => {
    const closing = close()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<'late'>((resolve) => (timer = setTimeout(resolve, CLOSE_MS, 'late')))
    const outcome = await Promise.race([closing.then(() => 'closed' as const), late])
    clearTimeout(timer)
    if (outcome === 'closed') return fs.rmSync(record, { force: true })

    app.process().kill('SIGKILL')
    closing.catch(() => undefined)
    const boxes = shown()
    fs.rmSync(record, { force: true })
    throw new Error(
      `The app did not close in ${CLOSE_MS / 1000} s, so it was killed. Message boxes shown: ${
        boxes.length === 0 ? 'none' : boxes.join('; ')
      }`
    )
  }
  return app
}
