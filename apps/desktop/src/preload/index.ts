import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IpcChannel,
  type CloseCheck,
  type DesktopApi,
  type RunStartRequest,
  type ProjectView,
  type Unsubscribe,
  type WorkspacesState
} from '../shared/ipc.js'

/**
 * The entire surface the renderer gets. No `ipcRenderer`, no Node, no filesystem:
 * only these calls, each one a named channel that main validates.
 */

/** Subscribe to a main->renderer channel, returning an unsubscribe function. */
function subscribe<T>(channel: string, callback: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: DesktopApi = {
  runStart: (request: RunStartRequest) => ipcRenderer.invoke(IpcChannel.runStart, request),
  runCollection: (request) => ipcRenderer.invoke(IpcChannel.runCollection, request),
  runCancel: (runId: string) => ipcRenderer.send(IpcChannel.runCancel, runId),
  runStop: (runId: string) => ipcRenderer.send(IpcChannel.runStop, runId),
  onRunProgress: (callback) => subscribe(IpcChannel.eventRunProgress, callback),
  onRunLive: (callback) => subscribe(IpcChannel.eventRunLive, callback),
  onConsole: (callback) => subscribe(IpcChannel.eventConsole, callback),
  closeConnection: (collectionPath: string, name?: string) =>
    ipcRenderer.send(IpcChannel.connectionClose, collectionPath, name),
  onConnections: (callback) => subscribe(IpcChannel.eventConnections, callback),

  workspaces: {
    list: () => ipcRenderer.invoke(IpcChannel.workspacesList),
    create: (name: string) => ipcRenderer.invoke(IpcChannel.workspaceCreate, name),
    rename: (id: string, name: string) => ipcRenderer.invoke(IpcChannel.workspaceRename, id, name),
    remove: (id: string) => ipcRenderer.invoke(IpcChannel.workspaceRemove, id),
    setActive: (id: string) => ipcRenderer.invoke(IpcChannel.workspaceSetActive, id),
    onChanged: (callback: (state: WorkspacesState) => void) =>
      subscribe(IpcChannel.eventWorkspaces, callback)
  },

  projects: {
    pick: () => ipcRenderer.invoke(IpcChannel.projectPick),
    addAll: (workspaceId: string, folder: string) =>
      ipcRenderer.invoke(IpcChannel.projectAddAll, workspaceId, folder),
    add: (workspaceId: string, folder: string, options?: { createCollections?: boolean }) =>
      ipcRenderer.invoke(IpcChannel.projectAdd, workspaceId, folder, options),
    clone: (workspaceId: string, url: string, parentDir: string) =>
      ipcRenderer.invoke(IpcChannel.projectClone, workspaceId, url, parentDir),
    remove: (id: string) => ipcRenderer.invoke(IpcChannel.projectRemove, id),
    reveal: (target: string) => ipcRenderer.invoke(IpcChannel.projectReveal, target),
    selectEnvironment: (id: string, environment: string | null) =>
      ipcRenderer.invoke(IpcChannel.projectSelectEnvironment, id, environment),
    createDirectory: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.projectCreateDirectory, id, name),
    addAgentsSection: (id: string) => ipcRenderer.invoke(IpcChannel.projectAddAgentsSection, id),
    createCollection: (id: string, directory: string | null, name: string, kind?) =>
      ipcRenderer.invoke(IpcChannel.projectCreateCollection, id, directory, name, kind),
    applyEdits: (id: string, baseSource: string | null, edits, target) =>
      ipcRenderer.invoke(IpcChannel.projectApplyEdits, id, baseSource, edits, target),
    renameFolder: (id: string, name: string, to: string) =>
      ipcRenderer.invoke(IpcChannel.projectRenameFolder, id, name, to),
    deleteFolder: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.projectDeleteFolder, id, name),
    createScratchPad: (workspaceId: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.projectCreateScratchPad, workspaceId, name),
    renameScratchPad: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.projectRenameScratchPad, id, name),
    pickFile: (request) => ipcRenderer.invoke(IpcChannel.projectPickFile, request),
    onUpdated: (callback: (project: ProjectView) => void) =>
      subscribe(IpcChannel.eventProject, callback)
  },

  git: {
    fetch: (id: string) => ipcRenderer.invoke(IpcChannel.gitFetch, id),
    pull: (id: string) => ipcRenderer.invoke(IpcChannel.gitPull, id),
    push: (id: string, remote?: string | null) =>
      ipcRenderer.invoke(IpcChannel.gitPush, id, remote),
    changes: (id: string) => ipcRenderer.invoke(IpcChannel.gitChanges, id),
    diff: (id: string, file: string) => ipcRenderer.invoke(IpcChannel.gitDiff, id, file),
    commit: (id: string, paths: string[], message: string) =>
      ipcRenderer.invoke(IpcChannel.gitCommit, id, paths, message),
    discard: (id: string, file: string) => ipcRenderer.invoke(IpcChannel.gitDiscard, id, file),
    log: (id: string, skip?: number) => ipcRenderer.invoke(IpcChannel.gitLog, id, skip),
    branches: (id: string) => ipcRenderer.invoke(IpcChannel.gitBranches, id),
    createBranch: (id: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.gitCreateBranch, id, name),
    switchBranch: (id: string, name: string, remote?: string | null) =>
      ipcRenderer.invoke(IpcChannel.gitSwitchBranch, id, name, remote),
    setIdentity: (id: string, name: string, email: string) =>
      ipcRenderer.invoke(IpcChannel.gitSetIdentity, id, name, email),
    lineEndings: (id: string) => ipcRenderer.invoke(IpcChannel.gitLineEndings, id),
    addAttributes: (id: string) => ipcRenderer.invoke(IpcChannel.gitAddAttributes, id),
    convertToLf: (id: string) => ipcRenderer.invoke(IpcChannel.gitConvertToLf, id),
    dismissLineEndings: (id: string) => ipcRenderer.invoke(IpcChannel.gitDismissLineEndings, id),
    setup: () => ipcRenderer.invoke(IpcChannel.gitSetup),
    onProgress: (callback) => subscribe(IpcChannel.eventGitProgress, callback)
  },

  collection: {
    read: (file: string) => ipcRenderer.invoke(IpcChannel.collectionRead, file),
    applyEdits: (file: string, baseSource: string, edits) =>
      ipcRenderer.invoke(IpcChannel.collectionApplyEdits, file, baseSource, edits),
    rename: (file: string, id: string) => ipcRenderer.invoke(IpcChannel.collectionRename, file, id),
    copy: (file: string, projectId: string, directory: string | null, move: boolean) =>
      ipcRenderer.invoke(IpcChannel.collectionCopy, file, projectId, directory, move),
    moveToFolder: (file: string, folder: string | null) =>
      ipcRenderer.invoke(IpcChannel.collectionMoveToFolder, file, folder),
    remove: (file: string) => ipcRenderer.invoke(IpcChannel.collectionDelete, file),
    committed: (file: string) => ipcRenderer.invoke(IpcChannel.collectionCommitted, file)
  },

  variables: {
    preview: (request) => ipcRenderer.invoke(IpcChannel.variablesPreview, request),
    copy: (request, name: string) => ipcRenderer.invoke(IpcChannel.variablesCopy, request, name)
  },

  data: {
    read: (collectionPath: string) => ipcRenderer.invoke(IpcChannel.dataRead, collectionPath),
    apply: (file: string, baseSource: string, table) =>
      ipcRenderer.invoke(IpcChannel.dataApply, file, baseSource, table),
    applyText: (file: string, baseSource: string, text: string) =>
      ipcRenderer.invoke(IpcChannel.dataApplyText, file, baseSource, text),
    create: (collectionPath: string, column: string) =>
      ipcRenderer.invoke(IpcChannel.dataCreate, collectionPath, column),
    remove: (file: string) => ipcRenderer.invoke(IpcChannel.dataDelete, file)
  },

  environment: {
    read: (file: string) => ipcRenderer.invoke(IpcChannel.environmentRead, file),
    applyEdits: (file: string, baseSource: string, edits) =>
      ipcRenderer.invoke(IpcChannel.environmentApplyEdits, file, baseSource, edits),
    create: (collectionPath: string, name: string) =>
      ipcRenderer.invoke(IpcChannel.environmentCreate, collectionPath, name),
    remove: (file: string) => ipcRenderer.invoke(IpcChannel.environmentDelete, file)
  },

  flags: {
    get: (root, environment, options) =>
      ipcRenderer.invoke(IpcChannel.flagsGet, root, environment, options),
    setOverride: (root, environment, name, value) =>
      ipcRenderer.invoke(IpcChannel.flagsSetOverride, root, environment, name, value)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.settingsGet),
    set: (patch) => ipcRenderer.invoke(IpcChannel.settingsSet, patch),
    onChanged: (callback) => subscribe(IpcChannel.eventSettings, callback)
  },
  editor: {
    open: (target) => ipcRenderer.invoke(IpcChannel.editorOpen, target),
    test: () => ipcRenderer.invoke(IpcChannel.editorTest)
  },

  app: {
    onBeforeClose: (handler) => {
      const listener = async (
        _event: IpcRendererEvent,
        requestId: string,
        request: { save: boolean }
      ) => {
        let answer: CloseCheck = { unsaved: [] }
        try {
          answer = await handler(request)
        } catch {
          // A handler that fails must not trap the window open.
        }
        ipcRenderer.send(IpcChannel.appCloseReply, requestId, answer)
      }
      ipcRenderer.on(IpcChannel.appBeforeClose, listener)
      return () => ipcRenderer.removeListener(IpcChannel.appBeforeClose, listener)
    },
    copyText: (text: string) => ipcRenderer.send(IpcChannel.appCopyText, text)
  },

  script: {
    check: (code: string) => ipcRenderer.invoke(IpcChannel.scriptCheck, code),
    rules: (code: string, allowed: string[]) =>
      ipcRenderer.invoke(IpcChannel.scriptRules, code, allowed)
  }
}

contextBridge.exposeInMainWorld('desktop', api)
