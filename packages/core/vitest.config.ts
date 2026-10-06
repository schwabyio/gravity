import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The git and workspace tests run real git, several processes a test. On a Windows
    // runner, with every worker spawning at once, five took over vitest's 5 s default
    // (CI, 2026-10-06), against well under a second on a Mac.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
