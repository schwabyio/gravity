import path from 'node:path'
import type { Dialog, ElectronApplication, Locator, Page } from '@playwright/test'

/** How long + Project may take to list a project: a Windows runner starts git slowly. */
const ADD_TIMEOUT = 30_000

/**
 * Add the project in `folder` with + Project, the folder dialog answering
 * with it, and wait for the sidebar to list it as `name` — by default the
 * folder's own name. Returns the project's region of the sidebar.
 *
 * When the sidebar has not listed it in time, this fails saying what the
 * sidebar said instead, any dialog the app raised, which projects it does
 * list and how long it waited, so a failure in CI reads from its annotation
 * alone: one the app reported, and one that was only slow, look different.
 */
export async function addProject(
  app: ElectronApplication,
  page: Page,
  folder: string,
  name: string = path.basename(folder)
): Promise<Locator> {
  await app.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] })
  }, folder)
  const asked: string[] = []
  // Dismissed, as Playwright does with no listener; only noted as well.
  const onDialog = (dialog: Dialog) => {
    asked.push(dialog.message())
    void dialog.dismiss()
  }
  page.on('dialog', onDialog)
  const region = page.getByRole('region', { name: `Project ${name}`, exact: true })
  const started = Date.now()
  try {
    await page.getByRole('button', { name: '+ Project' }).click()
    await region.waitFor({ timeout: ADD_TIMEOUT })
  } catch (cause) {
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const said = await page
      .locator('.sidebar-error, .sidebar-status')
      .allInnerTexts()
      .catch(() => [])
    const listed = await page
      .locator('.sidebar section.project')
      .evaluateAll((sections) => sections.map((section) => section.getAttribute('aria-label')))
      .catch(() => [])
    const quoted = (texts: Array<string | null>) =>
      texts.length > 0 ? texts.map((text) => `"${text}"`).join(', ') : 'nothing'
    throw new Error(
      [
        `+ Project on ${folder} did not list Project ${name} after ${seconds} s.`,
        `The sidebar said ${quoted(said)}; the app asked ${quoted(asked)};`,
        `it lists ${quoted(listed)}.`
      ].join(' '),
      { cause }
    )
  } finally {
    page.off('dialog', onDialog)
  }
  return region
}
