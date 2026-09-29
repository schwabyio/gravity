import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  // In CI, each failure is also an annotation on the run, readable without its log.
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' }
})
