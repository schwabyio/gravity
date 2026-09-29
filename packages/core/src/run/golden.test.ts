import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadCollection } from '../workspace/collection.js'
import { runCollection } from './runCollection.js'

/**
 * The converted xtest demo suite, run against its live host.
 *
 * Opt-in because it needs the network and a checkout of the demo workspace:
 *
 *     XTEST_DEMO_ROOT=../root-xtest-demo npx vitest run golden
 *
 * It prints every failing assertion rather than asserting a total, because a
 * handful of demo steps depend on the hour (the host computes dates in its own
 * time zone) and would make a fixed total flaky. What it does assert is that
 * the engine itself never throws.
 */
const root = process.env['XTEST_DEMO_ROOT']

describe.skipIf(!root)('golden: the converted xtest demo suite', () => {
  it('runs every collection without an engine error', async () => {
    const dir = path.resolve(root!, 'collections')
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.yml'))
      .sort()
    const counts = { pass: 0, fail: 0, error: 0, skipped: 0 }
    const failures: string[] = []

    for (const file of files) {
      const loaded = await loadCollection(path.join(dir, file), dir)
      // Data-file steps need per-row variables the runner does not supply yet.
      const collection = {
        ...loaded.doc,
        steps: loaded.doc.steps.filter((step) => !step.tags?.includes('data-file'))
      }
      const summary = await runCollection({
        collection,
        context: { collectionPath: loaded.path, environmentName: 'demo' }
      })
      for (const [index, result] of summary.results.entries()) {
        counts[result.status]++
        expect(result.error?.phase, `${file} #${index + 1}`).not.toBe('tests')
        for (const failed of result.assertions.filter((a) => a.status === 'fail')) {
          failures.push(`${file} #${index + 1}: ${failed.name} — ${failed.message ?? ''}`)
        }
        if (result.error) failures.push(`${file} #${index + 1}: ${result.error.message}`)
      }
    }

    console.log(`golden: ${JSON.stringify(counts)}\n${failures.join('\n')}`)
  }, 600_000)
})
