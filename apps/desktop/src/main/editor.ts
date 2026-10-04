import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { Settings } from '../shared/settings.js'
import { fileUrl, fillCommand, jetbrainsUrl, splitCommand } from './editorCommand.js'

/**
 * Open a file in the editor the person chose, at a line where there is one.
 *
 * Two things make this harder than it looks. An app started from the Dock or
 * the Start menu does not see a terminal's PATH, so `code` or `idea` may not
 * be found: VS Code and Cursor are opened by their links, and a JetBrains IDE
 * by its launcher, its app, or its link, whichever is there. And nothing runs
 * through a shell, so a path with spaces or odd characters is only ever a path.
 */
export async function openInEditor(
  editor: Settings['editor'],
  file: string,
  line?: number
): Promise<void> {
  switch (editor.kind) {
    case 'system': {
      const problem = await shell.openPath(file)
      if (problem) throw new Error(problem)
      return
    }
    case 'vscode':
    case 'cursor':
      return shell.openExternal(fileUrl(editor.kind, file, line))
    case 'intellij':
      return openJetBrains(JETBRAINS.idea, file, line)
    case 'webstorm':
      return openJetBrains(JETBRAINS.webstorm, file, line)
    case 'custom':
      return openWithCommand(editor.command, file, line)
  }
}

const JETBRAINS = {
  idea: {
    product: 'idea',
    app: /^IntelliJ IDEA.*\.app$/,
    folder: /^IntelliJ IDEA/,
    exe: 'idea64.exe'
  },
  webstorm: {
    product: 'webstorm',
    app: /^WebStorm.*\.app$/,
    folder: /^WebStorm/,
    exe: 'webstorm64.exe'
  }
} as const

type JetBrainsIde = (typeof JETBRAINS)[keyof typeof JETBRAINS]

/** Its launcher where one is installed, else its app, else its link. */
async function openJetBrains(ide: JetBrainsIde, file: string, line?: number): Promise<void> {
  const args = [...(line ? ['--line', String(line)] : []), file]
  // A Windows launcher is a .cmd, which runs only through a shell: its .exe instead.
  const launcher = process.platform === 'win32' ? null : await findProgram(ide.product)
  if (launcher) return start(launcher, args)
  if (process.platform === 'darwin') {
    const app = await findMacApp(ide.app)
    if (app) return start('open', ['-na', app, '--args', ...args])
  }
  if (process.platform === 'win32') {
    const exe = await findWindowsExe(ide.folder, ide.exe)
    if (exe) return start(exe, args)
  }
  return shell.openExternal(jetbrainsUrl(ide.product, file, line))
}

async function openWithCommand(command: string, file: string, line?: number): Promise<void> {
  const [program, ...rest] = fillCommand(splitCommand(command), file, line)
  if (!program) throw new Error('Set the command in App settings → External editor first')
  const found =
    program.includes('/') || program.includes('\\') ? program : await findProgram(program)
  const resolved = found ?? program
  if (/\.(cmd|bat)$/i.test(resolved)) {
    throw new Error(
      `${resolved} is a script, which runs only through a shell: give the program itself`
    )
  }
  return start(resolved, rest)
}

/** Start a program on its own, not waiting for it, and say so if it cannot start at all. */
function start(program: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { detached: true, stdio: 'ignore', shell: false })
    child.once('error', (cause) =>
      reject(new Error(`Could not start ${program}: ${cause.message}`))
    )
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

/** Where a terminal would find a program: PATH, and where installers put them that PATH may miss. */
async function findProgram(name: string): Promise<string | null> {
  const home = os.homedir()
  const folders = [
    ...(process.env['PATH'] ?? '').split(path.delimiter).filter(Boolean),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'Library', 'Application Support', 'JetBrains', 'Toolbox', 'scripts'),
    path.join(home, '.local', 'share', 'JetBrains', 'Toolbox', 'scripts')
  ]
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name]
  for (const folder of folders) {
    for (const candidate of names) {
      const full = path.join(folder, candidate)
      if (await runnable(full)) return full
    }
  }
  return null
}

async function runnable(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile()) return false
    if (process.platform !== 'win32') await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** A Mac app by its name, in the places apps are installed, the newest-named first. */
async function findMacApp(pattern: RegExp): Promise<string | null> {
  const home = os.homedir()
  for (const folder of [
    '/Applications',
    path.join(home, 'Applications'),
    path.join(home, 'Applications', 'JetBrains Toolbox')
  ]) {
    const names = (await fs.readdir(folder).catch(() => [] as string[])).filter((name) =>
      pattern.test(name)
    )
    const newest = names.sort().at(-1)
    if (newest) return path.join(folder, newest)
  }
  return null
}

/** A JetBrains IDE's .exe, where its installer or the Toolbox puts it, the newest-named first. */
async function findWindowsExe(folderPattern: RegExp, exe: string): Promise<string | null> {
  const roots = [
    process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'JetBrains'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')
  ].filter((root): root is string => Boolean(root))
  for (const root of roots) {
    const names = (await fs.readdir(root).catch(() => [] as string[])).filter((name) =>
      folderPattern.test(name)
    )
    for (const name of names.sort().reverse()) {
      const full = path.join(root, name, 'bin', exe)
      if (await runnable(full)) return full
    }
  }
  return null
}
