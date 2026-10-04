/**
 * Bundle gta into dist/: `gta.js` (the bin), `worker.js` (one per running
 * collection), and the library — `index.js` for `@schwabyio/gta` and
 * `playwright.js` for `@schwabyio/gta/playwright` — sharing a chunk that holds
 * the core.
 *
 * Everything is bundled — the core, undici, yaml, zod — so a global install is
 * a folder with no dependencies to resolve, and it runs wherever Node does.
 * Only Playwright is not: a test that imports the library brings its own.
 * Beside the code go the library's `.d.ts` files, SPEC.md, which gta's
 * messages cite, FUNCTIONS.md, which SPEC.md links to, and the licenses of the
 * packages the bundle took in.
 */
import { chmod, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'
import ts from 'typescript'

const here = import.meta.dirname
const outdir = path.join(here, 'dist')
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))

await rm(outdir, { recursive: true, force: true })
const { metafile } = await build({
  entryPoints: {
    gta: 'src/gta.ts',
    worker: 'src/worker.ts',
    index: 'src/library/index.ts',
    playwright: 'src/library/playwright.ts'
  },
  // The test's own Playwright: a second copy would not be the runner's.
  external: ['@playwright/test'],
  absWorkingDir: here,
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  chunkNames: 'chunks/[name]-[hash]',
  define: { __GTA_VERSION__: JSON.stringify(pkg.version) },
  // undici is CommonJS and requires Node built-ins; an ESM bundle has no `require`.
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __gtaCreateRequire } from 'node:module';",
      'const require = __gtaCreateRequire(import.meta.url);'
    ].join('\n')
  },
  metafile: true,
  logLevel: 'warning'
})

// `npm install -g ./apps/cli` links to this folder rather than copying it, so
// npm never marks the bin executable: the build does, every time it rewrites it.
await chmod(path.join(outdir, 'gta.js'), 0o755)

await writeLibraryTypes()

for (const doc of ['SPEC.md', 'FUNCTIONS.md']) {
  await copyFile(path.join(here, '..', '..', doc), path.join(outdir, doc))
}
await writeFile(path.join(outdir, 'THIRD_PARTY_NOTICES.txt'), await notices(metafile))

/**
 * The library's `.d.ts` files, each made from its own source alone: every
 * export says its type outright, and the types it names are written out in
 * `types.ts`, so nothing points into the core, which does not ship. A file
 * that would need another to say its types stops the build.
 */
async function writeLibraryTypes() {
  for (const name of ['index', 'playwright', 'types']) {
    const fileName = path.join(here, 'src', 'library', `${name}.ts`)
    const { outputText, diagnostics = [] } = ts.transpileDeclaration(
      await readFile(fileName, 'utf8'),
      {
        fileName,
        reportDiagnostics: true,
        compilerOptions: {
          isolatedDeclarations: true,
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2023
        }
      }
    )
    if (diagnostics.length > 0) {
      const messages = diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      throw new Error(`src/library/${name}.ts cannot be declared alone:\n${messages.join('\n')}`)
    }
    await writeFile(path.join(outdir, `${name}.d.ts`), outputText)
  }
}

/**
 * Each npm package the bundle took in, with its license. MIT and ISC ask for the
 * notice to travel with the code, and the bundle is the only copy a user gets.
 * A bundled package with no license file stops the build.
 */
async function notices(metafile) {
  const packageDirs = new Set()
  for (const input of Object.keys(metafile.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll('\\', '/'))
    if (match) packageDirs.add(path.join(here, match[1]))
  }

  const sections = []
  for (const dir of packageDirs) {
    const { name, version, license } = JSON.parse(
      await readFile(path.join(dir, 'package.json'), 'utf8')
    )
    const file = (await readdir(dir)).find((entry) => /^(licen[cs]e|copying)/i.test(entry))
    if (!file) throw new Error(`${name} is bundled into gta but has no license file in ${dir}`)
    const text = (await readFile(path.join(dir, file), 'utf8')).trim()
    sections.push({ name, text: `${name} ${version} (${license})\n\n${text}` })
  }
  sections.sort((a, b) => a.name.localeCompare(b.name))

  const intro =
    'gta bundles the following packages. Each is used under the license that follows it.'
  const separator = `\n\n${'-'.repeat(80)}\n\n`
  return [intro, ...sections.map((section) => section.text)].join(separator) + '\n'
}
