/**
 * Bundle gta into dist/: `gta.js` (the bin) and `worker.js` (one per running
 * collection), sharing a chunk that holds the core.
 *
 * Everything is bundled — the core, undici, yaml, zod — so a global install is
 * a folder with no dependencies to resolve, and it runs wherever Node does.
 * Beside the code go SPEC.md, which gta's messages cite, and the licenses of
 * the packages the bundle took in.
 */
import { chmod, copyFile, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { build } from 'esbuild'

const here = import.meta.dirname
const outdir = path.join(here, 'dist')
const pkg = JSON.parse(await readFile(path.join(here, 'package.json'), 'utf8'))

await rm(outdir, { recursive: true, force: true })
const { metafile } = await build({
  entryPoints: { gta: 'src/gta.ts', worker: 'src/worker.ts' },
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

await copyFile(path.join(here, '..', '..', 'SPEC.md'), path.join(outdir, 'SPEC.md'))
await writeFile(path.join(outdir, 'THIRD_PARTY_NOTICES.txt'), await notices(metafile))

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
