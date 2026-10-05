import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/desktop', 'apps/cli'],
    // `npm run coverage`: what the unit tests reach, reported by mcr.config.mjs into
    // coverage/unit. The desktop app's components and hooks are tested end to end
    // instead (apps/desktop/e2e): `npm run coverage:e2e` adds those.
    coverage: {
      provider: 'custom',
      customProviderModule: 'vitest-monocart-coverage',
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      // What vitest empties before a run: the unit tests' raw data, not the end-to-end ones'.
      reportsDirectory: 'coverage/raw/unit'
    }
  }
})
