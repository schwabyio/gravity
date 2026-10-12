import type { Page } from '@playwright/test'
import type { LoadEvent } from '../src/shared/ipc'

/** How long main has to answer: it answers at once unless something holds it up. */
const ANSWER_MS = 2_000

/**
 * The app's load log, a line each, as the Console's "Loading projects" shows it,
 * problems marked with `!`. For a failure's message, so a CI annotation says what
 * the app read and what it could not. When main does not answer at all, that is
 * said instead: something, an error dialog perhaps, is holding it up.
 */
export async function loadLog(page: Page): Promise<string> {
  const history = page.evaluate(() =>
    (
      globalThis as unknown as { desktop: { consoleHistory(): Promise<LoadEvent[]> } }
    ).desktop.consoleHistory()
  )
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ANSWER_MS))
  const events = await Promise.race([history, timeout]).catch(() => null)
  if (events === null) return `Load log: main did not answer in ${ANSWER_MS / 1000} s`
  const lines = events
    .filter((event) => event.kind === 'load')
    .map((event) => `${event.problem ? '! ' : '  '}${event.subject}: ${event.text}`)
  return `Load log:\n${lines.join('\n')}`
}
