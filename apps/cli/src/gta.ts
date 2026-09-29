/**
 * The `gta` bin: xrun's contract over the Gravity core.
 *
 *     cd my-project && gta all --environmentType staging --limitConcurrency 8
 */
import { colorWanted } from './report.js'
import { main } from './main.js'
import { openFile } from './open.js'
import { workerRunner } from './pool.js'

// Beside this file in dist/, wherever the bundle is installed.
const workerUrl = new URL('./worker.js', import.meta.url)

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  color: colorWanted(process.stdout, process.env),
  runner: (settings) => workerRunner(workerUrl, settings.timeoutCollection),
  open: openFile
})
