import { createContext, useContext } from 'react'
import type { EditorTarget } from '@shared/ipc.js'

/**
 * The external editor App settings name, for any "Open in …" link: what the
 * link says — `Open in VS Code` — and a way to open a place in a file.
 */
export interface ExternalEditor {
  label: string
  open: (target: EditorTarget) => void
}

export const ExternalEditorContext = createContext<ExternalEditor | null>(null)

/** The editor, or null where none is given: then no "Open in …" link shows. */
export const useExternalEditor = (): ExternalEditor | null => useContext(ExternalEditorContext)

/** A file next to another: `project.yml` beside a project's root, with its separator. */
export function joinPath(folder: string, name: string): string {
  const separator = folder.includes('\\') && !folder.includes('/') ? '\\' : '/'
  return `${folder.replace(/[\\/]+$/, '')}${separator}${name}`
}
