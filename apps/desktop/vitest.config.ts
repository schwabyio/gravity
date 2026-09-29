import { defineConfig } from 'vitest/config'

// Unit tests for main-process logic that needs no Electron; the app itself is
// tested end to end with Playwright (e2e/).
export default defineConfig({
  test: {
    name: 'desktop',
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
