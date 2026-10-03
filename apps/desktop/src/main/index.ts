import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron'
import { IpcChannel } from '../shared/ipc.js'
import { setupGit } from './bundledGit.js'
import {
  broadcastGitProgress,
  broadcastProjects,
  broadcastRunProgress,
  broadcastSettings,
  registerIpc
} from './ipc.js'
import { migrateUserData, placeUserData } from './migrateUserData.js'
import { runSupervisor } from './runSupervisor.js'
import { ProjectService } from './projectService.js'

const isDev = !app.isPackaged

placeUserData()
migrateUserData()
// A discarded change goes to the Trash, so it can be got back. Looked up on
// each call rather than bound once. Scratch pads live in the app's own data,
// asked for only once the app is ready and `--user-data-dir` has been applied.
const projects = new ProjectService({
  moveAside: (file) => shell.trashItem(file),
  scratchPads: () => path.join(app.getPath('userData'), 'Scratch pads')
})

function createWindow(): void {
  // Never larger than the screen it opens on, whose edges would hide its own.
  const { workAreaSize } = screen.getPrimaryDisplay()
  const window = new BrowserWindow({
    width: Math.min(1440, workAreaSize.width),
    height: Math.min(900, workAreaSize.height),
    center: true,
    minWidth: 1000,
    minHeight: 640,
    title: 'Gravity',
    show: false,
    backgroundColor: '#11131a',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      // The renderer gets no Node, no remote module and its own context.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false
    }
  })

  window.once('ready-to-show', () => window.show())
  guardUnsavedEdits(window)

  // Send the current list as soon as the page is live, so a reload does not need
  // the renderer to ask twice.
  window.webContents.on('did-finish-load', () => {
    window.webContents.send(IpcChannel.eventWorkspaces, projects.state())
  })

  // Anything trying to open a new window or navigate away goes to the real
  // browser instead; the renderer only ever hosts our own page.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  registerIpc(projects)
  broadcastProjects(projects)
  broadcastGitProgress(projects)
  broadcastRunProgress()
  broadcastSettings()
  createWindow()

  // Reading projects touches the filesystem and git, so it happens after the
  // window is up rather than delaying first paint.
  const git = await setupGit()
  if (git.note) console.warn(git.note)
  projects.setGit(git)
  await projects.init()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Never lose an edit to closing the window.
 *
 * On close, main asks the renderer what is unsaved (with auto save on, the
 * renderer saves first and has nothing to report). Anything left is put to the
 * person — Save, Don't Save, Cancel — rather than dropped. A renderer that does
 * not answer within a few seconds does not keep the window open.
 */
function guardUnsavedEdits(window: BrowserWindow) {
  let allowed = false
  window.on('close', (event) => {
    if (allowed) return
    event.preventDefault()
    void (async () => {
      let check = await ask(window, false)
      if (check.unsaved.length > 0) {
        const { response } = await dialog.showMessageBox(window, {
          type: 'warning',
          buttons: ['Save', "Don't Save", 'Cancel'],
          defaultId: 0,
          cancelId: 2,
          message: 'Save your changes before closing?',
          detail: `Unsaved edits in ${check.unsaved.join(', ')}.`
        })
        if (response === 2) {
          quitting = false
          return
        }
        if (response === 0) {
          check = await ask(window, true)
          if (check.unsaved.length > 0) {
            const { response: anyway } = await dialog.showMessageBox(window, {
              type: 'error',
              buttons: ['Close Anyway', 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              message: 'Some changes could not be saved.',
              detail: `Still unsaved: ${check.unsaved.join(', ')}.`
            })
            if (anyway !== 0) {
              quitting = false
              return
            }
          }
        }
      }
      allowed = true
      window.close()
      // Holding the window open cancelled a quit in progress; resume it.
      if (quitting) app.quit()
    })()
  })
}

let closeRequests = 0
/** Set once a quit starts, so a close we held up can let the quit carry on. */
let quitting = false
app.on('before-quit', () => {
  quitting = true
})

function ask(window: BrowserWindow, save: boolean): Promise<{ unsaved: string[] }> {
  const requestId = `close-${++closeRequests}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish({ unsaved: [] }), 5000)
    const onReply = (_event: unknown, id: string, answer: { unsaved?: unknown }) => {
      if (id !== requestId) return
      finish({
        unsaved: Array.isArray(answer?.unsaved) ? answer.unsaved.map(String) : []
      })
    }
    const finish = (answer: { unsaved: string[] }) => {
      clearTimeout(timer)
      ipcMain.removeListener(IpcChannel.appCloseReply, onReply)
      resolve(answer)
    }
    ipcMain.on(IpcChannel.appCloseReply, onReply)
    if (window.webContents.isDestroyed()) finish({ unsaved: [] })
    else window.webContents.send(IpcChannel.appBeforeClose, requestId, { save })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// Only once every window has agreed to close: a window held open to ask about
// unsaved edits may still need a disk change the watchers are about to report.
app.on('will-quit', () => {
  runSupervisor.dispose()
  projects.dispose()
})
