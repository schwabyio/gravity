import { spawn } from 'node:child_process'

/**
 * Open a file with the system's handler for it — the default browser, for a
 * report. Nothing waits on it, and a machine with no handler (a CI runner)
 * just does not open anything.
 */
export function openFile(file: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [file]]
      : process.platform === 'win32'
        ? ['explorer.exe', [file]]
        : ['xdg-open', [file]]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // No handler: the path is printed, which is enough.
  }
}
