import type { Page } from '@playwright/test'
import type { LoadEvent, WorkspacesState } from '../src/shared/ipc'

/** How long main has to answer: it answers at once unless something holds it up. */
const ANSWER_MS = 2_000

/** What main answers, or null when it does not in time. */
function answer<T>(page: Page, ask: () => Promise<T>): Promise<T | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), ANSWER_MS))
  return Promise.race([page.evaluate(ask), timeout]).catch(() => null)
}

/**
 * The app's load log, a line each, as the Console's "Loading projects" shows it,
 * problems marked with `!`. For a failure's message, so a CI annotation says what
 * the app read and what it could not. When main does not answer at all, that is
 * said instead: something, an error dialog perhaps, is holding it up.
 *
 * With `since`, each line says when it was written from then: `+0.2 s`. With
 * `project`, main's own view of it follows, so the message says whether main
 * read what the window did not show.
 */
export async function loadLog(
  page: Page,
  options: { since?: number; project?: string } = {}
): Promise<string> {
  type Desktop = {
    desktop: {
      consoleHistory(): Promise<LoadEvent[]>
      workspaces: { list(): Promise<WorkspacesState> }
    }
  }
  const events = await answer(page, () =>
    (globalThis as unknown as Desktop).desktop.consoleHistory()
  )
  if (events === null) return `Load log: main did not answer in ${ANSWER_MS / 1000} s`
  const { since } = options
  const when = (at: number) => {
    if (since === undefined) return ''
    const seconds = (at - since) / 1000
    return `${seconds < 0 ? '-' : '+'}${Math.abs(seconds).toFixed(1)} s  `
  }
  const lines = events
    .filter((event) => event.kind === 'load')
    .map(
      (event) => `${when(event.at)}${event.problem ? '! ' : '  '}${event.subject}: ${event.text}`
    )
  let main = ''
  if (options.project !== undefined) {
    const state = await answer(page, () =>
      (globalThis as unknown as Desktop).desktop.workspaces.list()
    )
    const view = state?.projects.find((project) => project.name === options.project)
    main = !state
      ? `\n\nMain's view: main did not answer in ${ANSWER_MS / 1000} s`
      : !view
        ? `\n\nMain's view: no project ${options.project}`
        : `\n\nMain's view of ${view.name}: ${view.problems.length} problem(s)${view.problems.map((problem) => `\n  ${problem.path}: ${problem.message}`).join('')}`
  }
  return `Load log:\n${lines.join('\n')}${main}`
}
