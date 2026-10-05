import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CoverageReport } from 'monocart-coverage-reports'
import ts from 'typescript'

/**
 * Coverage, reported by monocart-coverage-reports: `npm run coverage` for the unit
 * tests (through vitest-monocart-coverage, see vitest.config.ts), and
 * `npm run coverage:e2e` (apps/desktop/e2e-coverage.mjs), which adds the
 * end-to-end tests and merges the two. One tool, so the numbers add up.
 */

/** Where the code is: every file under these counts, tested or not. */
export const SOURCES = ['packages/core/src', 'apps/cli/src', 'apps/desktop/src']

/**
 * A source as every report names it, from the repository's root:
 * `packages/core/src/x.ts`. The desktop app's window bundle names its sources
 * from the app's folder (`src/renderer/src/App.tsx`): they are put under it.
 */
export const sourcePath = (filePath) => {
  const source = filePath.replace(/\\/g, '/')
  const rooted = /(?:^|\/)((?:apps|packages)\/[^/]+\/src\/.*)$/.exec(source)
  if (rooted) return rooted[1]
  return source.startsWith('src/') ? `apps/desktop/${source}` : source
}

/** The code itself: not tests, type declarations or what is bundled from node_modules. */
export const sourceFilter = (filePath) => {
  const source = sourcePath(filePath)
  return (
    !source.includes('node_modules') &&
    /^(apps|packages)\/[^/]+\/src\//.test(source) &&
    !/\.test\.tsx?$|\.d\.ts$/.test(source)
  )
}

/**
 * Files no test reached, at 0%: compiled from TypeScript first, so they are
 * counted as the ones that ran are.
 */
export const all = {
  dir: SOURCES,
  filter: (filePath) => /\.tsx?$/.test(filePath) && !/\.test\.tsx?$|\.d\.ts$/.test(filePath),
  transformer: async (entry) => {
    const file = fileURLToPath(entry.url)
    const { outputText, sourceMapText } = ts.transpileModule(entry.source, {
      fileName: path.basename(file),
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
        sourceMap: true
      }
    })
    const sourceMap = JSON.parse(sourceMapText ?? '{}')
    // Named by its whole path, as a tested file is, not by its file name alone.
    sourceMap.sources = [file]
    sourceMap.sourcesContent = [entry.source]
    entry.source = outputText.replace(/\/\/# sourceMappingURL=.*$/m, '')
    entry.sourceMap = sourceMap
  }
}

/**
 * A report — a summary in the terminal, index.html and coverage-summary.json in
 * `outputDir`, made afresh — from raw data: one run's, or several merged source
 * by source. Files under `dirs` that no test reached are added here, once, at
 * 0%: in the raw data they would be counted again beside a run that reached them.
 */
export function report(name, inputDir, outputDir, dirs = SOURCES) {
  return new CoverageReport({
    name,
    inputDir,
    outputDir,
    reports: ['console-summary', 'v8', 'json-summary'],
    sourceFilter,
    sourcePath,
    all: { ...all, dir: dirs }
  }).generate()
}

/** Where each run's raw data is kept, apart from the reports made from it. */
export const RAW = { unit: 'coverage/raw/unit/data', e2e: 'coverage/raw/e2e/data' }

/**
 * `npm run coverage`: the unit tests' raw data into coverage/raw/unit, then
 * their report into coverage/unit.
 */
export default {
  name: 'Gravity unit tests',
  outputDir: 'coverage/raw/unit',
  reports: [['raw', { outputDir: 'data' }]],
  sourceFilter,
  sourcePath,
  onEnd: () => report('Gravity unit tests', RAW.unit, 'coverage/unit')
}
