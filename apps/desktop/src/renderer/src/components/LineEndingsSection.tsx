import { useCallback, useEffect, useState } from 'react'
import type { LineEndingsView, ProjectView } from '@shared/ipc.js'

/**
 * Whether git keeps a project's files LF, in Project settings — and, when it
 * does not, the offer of a `.gitattributes` rule that makes it. Nothing is
 * written until asked (SPEC.md §1.2).
 */
export default function LineEndingsSection(props: {
  project: ProjectView
  onOpenChanges: () => void
}) {
  const { project } = props
  const [view, setView] = useState<LineEndingsView | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [converted, setConverted] = useState<number | null>(null)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    const result = await window.desktop.git.lineEndings(project.id)
    if (result.ok) setView(result.lineEndings)
    else setProblem(result.message)
  }, [project.id])

  // Reread when the project is: a pull or a commit elsewhere may have settled it.
  useEffect(() => void load(), [load, project])

  const act = async (call: () => Promise<{ ok: boolean; message?: string }>) => {
    setWorking(true)
    setProblem(null)
    const result = await call()
    setWorking(false)
    if (!result.ok) setProblem(result.message ?? 'That did not work')
    await load()
  }

  return (
    <section aria-labelledby="project-eol-title">
      <h3 id="project-eol-title">Line endings</h3>
      {!view ? (
        <p className="hint">{problem ?? 'Reading git…'}</p>
      ) : !view.isRepo ? (
        <p className="hint">
          This project is not in a git repository. The app writes its files with LF line endings.
        </p>
      ) : (
        <>
          {view.covered ? (
            <p className="hint" role="status">
              git stores this project&rsquo;s files with LF line endings and checks them out LF on
              every platform
              {view.hasBlock ? (
                <>
                  , as its <code>.gitattributes</code> says.
                </>
              ) : (
                '.'
              )}
            </p>
          ) : (
            <>
              <p className="hint">
                The app writes LF line endings, but git on Windows may check this project&rsquo;s
                files out with CRLF, and a colleague&rsquo;s editor may commit them that way. A{' '}
                <code>.gitattributes</code> in the project keeps them LF for everyone, and keeps
                files a request uploads, in <code>files/</code>, exactly as committed. It covers
                only the project&rsquo;s own files, never other code in the folder.
              </p>
              <details className="eol-block">
                <summary>What it adds</summary>
                <pre>{view.block}</pre>
              </details>
              <button
                type="button"
                disabled={working}
                onClick={() => void act(() => window.desktop.git.addAttributes(project.id))}
              >
                Add .gitattributes
              </button>
            </>
          )}
          {view.crlfFiles.length > 0 && (
            <p className="hint eol-crlf">
              {view.crlfFiles.length} file{view.crlfFiles.length === 1 ? ' is' : 's are'} stored
              with CRLF line endings.{' '}
              <button
                type="button"
                disabled={working}
                onClick={() =>
                  void act(async () => {
                    const result = await window.desktop.git.convertToLf(project.id)
                    if (result.ok) setConverted(result.files.length)
                    return result
                  })
                }
              >
                Convert to LF
              </button>
            </p>
          )}
          {converted !== null && (
            <p className="hint" role="status">
              Converted {converted} file{converted === 1 ? '' : 's'} to LF: commit{' '}
              {converted === 1 ? 'it' : 'them'} from Changes.{' '}
              <button type="button" onClick={props.onOpenChanges}>
                Open Changes
              </button>
            </p>
          )}
        </>
      )}
      {problem && view && (
        <p className="setting-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  )
}
