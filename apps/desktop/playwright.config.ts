import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // A Windows runner starts processes, git above all, far more slowly than a
  // laptop: adding a project there has taken more than the default 5 s to show.
  expect: { timeout: process.env['CI'] ? 15_000 : 5_000 },
  fullyParallel: false,
  workers: 1,
  // In CI, each failure is also an annotation on the run, readable without its log.
  reporter: process.env['CI'] ? [['list'], ['github']] : [['list']],
  use: { trace: 'retain-on-failure' }
})
