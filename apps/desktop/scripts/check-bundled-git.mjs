// Before `npm run dev` and `npm start`: stop when the git the desktop app bundles
// is not there. `npm install` downloads it with dugite's own install script, and a
// failed download is easy to miss in npm's output; the app would then quietly run
// the system git. Only a check: dugite's download script deletes and unpacks the
// git again every time it runs.
import console from 'node:console'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const { resolveEmbeddedGitDir, setupEnvironment } = createRequire(import.meta.url)('dugite')

let gitLocation
try {
  gitLocation = setupEnvironment({}, process.env).gitLocation
} catch {
  // No bundled git for this platform: the app says so, and runs the system git.
  process.exit(0)
}

if (!existsSync(gitLocation)) {
  const lines = [`The git the desktop app bundles is not at ${gitLocation}.`]
  if (process.env['LOCAL_GIT_DIRECTORY']) {
    lines.push('LOCAL_GIT_DIRECTORY points there: point it at a git, or unset it.')
  } else {
    const download = path.join(resolveEmbeddedGitDir(), '..', 'script', 'download-git.js')
    lines.push(
      'npm install downloads it, so that download failed. To download it now, run:',
      '',
      `  node "${download}"`
    )
  }
  console.error(`\n${lines.join('\n')}\n`)
  process.exit(1)
}
