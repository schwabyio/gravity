import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop', 'apps/cli'],
    // `npm run coverage`: what the unit tests reach. The desktop app's components and
    // hooks are tested end to end instead (apps/desktop/e2e), which this does not count.
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      // A summary in the terminal, a page per file in coverage/index.html, and
      // coverage/coverage-summary.json to compare one run with the next.
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      // A slow test under instrumentation still says how far the rest reached.
      reportOnFailure: true
    }
  }
})
