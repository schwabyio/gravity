import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectDoc, VariablePreviews, Vars } from '@schwabyio/gravity-core/model'
import type { CaFileView, ProjectEdit, ProjectView } from '@shared/ipc.js'
import LineEndingsSection from './LineEndingsSection.js'
import Tooltip from './Tooltip.js'
import VariablesEditor from './VariablesEditor.js'

interface Props {
  project: ProjectView
  autoSave: { enabled: boolean; delayMs: number }
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
  /** Open the Changes drawer for the project's repository. */
  onOpenChanges: () => void
  onClose: () => void
}

interface Draft {
  name: string
  uses: string
  vars: Vars | undefined
  /** `tls.ca`, as typed: a row can be empty while it is being filled in. */
  ca: string[]
}

const draftOf = (doc: Partial<ProjectDoc> | null): Draft => ({
  name: doc?.name ?? '',
  uses: doc?.uses ?? '',
  vars: doc?.vars,
  ca: doc?.tls?.ca ?? []
})

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The edits that turn `doc` into `draft`, for `keys` only; an empty field removes its key. */
function editsFor(
  doc: Partial<ProjectDoc> | null,
  draft: Draft,
  keys: ReadonlyArray<ProjectEdit['key']>
): ProjectEdit[] {
  const ca = draft.ca.map((file) => file.trim()).filter((file) => file !== '')
  const wanted = {
    name: draft.name.trim() === '' ? undefined : draft.name,
    uses: draft.uses.trim() === '' ? undefined : draft.uses.trim(),
    vars: draft.vars && Object.keys(draft.vars).length > 0 ? draft.vars : undefined,
    tls: ca.length > 0 ? { ...doc?.tls, ca } : undefined
  }
  return keys
    .filter((key) => !same(wanted[key], doc?.[key]))
    .map((key) => ({ key, value: wanted[key] }))
}

type SaveState = 'idle' | 'saving' | 'conflict'

/**
 * One `project.yml` being edited — this project's, or its global project's —
 * saved after the auto save delay (or on Save), only against the text it was
 * read as, and following the file when it changes with nothing unsaved.
 */
function useProjectFile(options: {
  projectId: string
  target: 'project' | 'global'
  doc: Partial<ProjectDoc> | null
  source: string | null
  keys: ReadonlyArray<ProjectEdit['key']>
  autoSave: { enabled: boolean; delayMs: number }
  /** Which file this is; when it changes — a new global project — start from it afresh. */
  identity: string | null
}) {
  const { projectId, target, doc, source, keys, autoSave, identity } = options
  const [draft, setDraft] = useState<Draft>(() => draftOf(doc))
  const [state, setState] = useState<SaveState>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [version, setVersion] = useState(0)

  const edits = editsFor(doc, draft, keys)
  const dirty = edits.length > 0

  const lastSource = useRef(source)
  const lastIdentity = useRef(identity)
  useEffect(() => {
    if (source === lastSource.current && identity === lastIdentity.current) return
    // Another file altogether: nothing typed was meant for it.
    const another = identity !== lastIdentity.current || lastSource.current === null
    lastSource.current = source
    lastIdentity.current = identity
    setDraft((current) =>
      another || editsFor(doc, current, keys).length === 0 ? draftOf(doc) : current
    )
  }, [source, identity, doc, keys])

  const save = useCallback(async (): Promise<boolean> => {
    if (edits.length === 0 || state === 'conflict') return true
    setState('saving')
    const result = await window.desktop.projects.applyEdits(projectId, source, edits, target)
    if (!result.ok) {
      setState('idle')
      setMessage(result.message)
      return false
    }
    if (result.conflict) {
      setState('conflict')
      return false
    }
    setState('idle')
    setMessage(null)
    return true
  }, [edits, state, projectId, source, target])

  useEffect(() => {
    if (!autoSave.enabled || version === 0) return
    const timer = setTimeout(() => void save(), autoSave.delayMs)
    return () => clearTimeout(timer)
    // Restarted by each edit, not by the save function changing identity.
  }, [version, autoSave.enabled, autoSave.delayMs])

  return {
    draft,
    dirty,
    state,
    message,
    save,
    change: (patch: Partial<Draft>) => {
      setDraft((current) => ({ ...current, ...patch }))
      setMessage(null)
      setVersion((v) => v + 1)
    },
    reload: () => {
      setDraft(draftOf(doc))
      setState('idle')
    },
    status:
      state === 'saving'
        ? 'Saving…'
        : state === 'conflict'
          ? null
          : dirty
            ? autoSave.enabled
              ? 'Editing…'
              : 'Unsaved changes'
            : 'Saved'
  }
}

const OWN_KEYS = ['name', 'uses', 'vars', 'tls'] as const
const SHARED_KEYS = ['vars'] as const

/**
 * A project's `project.yml`, in a drawer: its name, the global project it
 * uses, project-wide variables and the CA certificates it trusts — and, when
 * it uses a global project, that project's shared variables, edited in place
 * for every project using it.
 */
export default function ProjectSettingsDrawer({
  project,
  autoSave,
  onClose,
  onOpenChanges,
  ...props
}: Props) {
  const panel = useRef<HTMLElement>(null)
  const own = useProjectFile({
    projectId: project.id,
    target: 'project',
    doc: project.project,
    source: project.projectSource,
    keys: OWN_KEYS,
    autoSave,
    identity: project.path
  })
  const global = project.global
  const shared = useProjectFile({
    projectId: project.id,
    target: 'global',
    doc: global ? { vars: global.vars ?? undefined } : null,
    source: global?.source ?? null,
    keys: SHARED_KEYS,
    autoSave,
    identity: global?.path ?? null
  })
  const files = global ? [own, shared] : [own]
  /** Why the folder chosen for `uses:` could not be named, when it could not. */
  const [choosing, setChoosing] = useState<string | null>(null)

  // Picked rather than typed: from a scratch pad in the app's data, the path
  // to a repository is a long run of ../ nobody wants to count.
  const chooseGlobal = async () => {
    const result = await window.desktop.projects.pickFile({ kind: 'global', projectId: project.id })
    if (!result.ok) return setChoosing(result.message)
    setChoosing(null)
    if (result.path) own.change({ uses: result.path })
  }

  const close = useCallback(async () => {
    const unsaved = files.filter((file) => file.dirty && file.state !== 'conflict')
    if (unsaved.length > 0) {
      if (autoSave.enabled) {
        const saved = await Promise.all(unsaved.map((file) => file.save()))
        if (!saved.every(Boolean)) return
      } else if (!window.confirm('Discard your unsaved changes?')) {
        return
      }
    }
    onClose()
  }, [files, autoSave.enabled, onClose])

  // Focus the drawer once, on opening; Escape closes it.
  useEffect(() => panel.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  return (
    <>
      <div className="drawer-scrim" onClick={() => void close()} />
      <aside
        ref={panel}
        className="drawer"
        role="dialog"
        aria-label="Project settings"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>Project settings</h2>
          <button
            type="button"
            className="drawer-close"
            onClick={() => void close()}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="drawer-body">
          <FileStatus
            label={
              <>
                <code>project.yml</code> in {project.name}
              </>
            }
            file={own}
            autoSave={autoSave.enabled}
          />

          <section aria-labelledby="project-general-title">
            <h3 id="project-general-title">Project</h3>
            <label className="project-field">
              <span className="field-label">Name</span>
              <input
                value={own.draft.name}
                placeholder={project.path.split(/[\\/]/).pop()}
                aria-label="Project name"
                onChange={(e) => own.change({ name: e.target.value })}
              />
            </label>
            <label className="project-field">
              <span className="field-label">Uses (a global project)</span>
              <span className="field-with-button">
                <input
                  value={own.draft.uses}
                  placeholder="../shared"
                  aria-label="Global project"
                  spellCheck={false}
                  onChange={(e) => own.change({ uses: e.target.value })}
                />
                <button type="button" onClick={() => void chooseGlobal()}>
                  Choose…
                </button>
              </span>
            </label>
            {choosing && (
              <p className="setting-error" role="alert">
                {choosing}
              </p>
            )}
            <p className="hint">
              A path relative to this project, written with <code>/</code> so it works on every
              machine. The global project gives every project that uses it its variables and
              environments.
              {global && (
                <>
                  {' '}
                  Now: <strong>{global.name}</strong>.
                </>
              )}
            </p>
            {project.problems
              .filter((problem) => problem.path === 'project.yml')
              .map((problem) => (
                <p key={problem.message} className="setting-error" role="alert">
                  {problem.message}
                </p>
              ))}
          </section>

          <section aria-labelledby="project-vars-title">
            <h3 id="project-vars-title">Variables</h3>
            <p className="hint">
              In scope for every collection in this project, over the shared variables and under
              each collection&rsquo;s own.
            </p>
            <div aria-label="Project variables" role="group">
              <VariablesEditor
                vars={own.draft.vars}
                onChange={(vars) => own.change({ vars: vars as Vars | undefined })}
                previews={props.previews}
                onCopyVariable={props.onCopyVariable}
              />
            </div>
          </section>

          <CaSection project={project} ca={own.draft.ca} onChange={(ca) => own.change({ ca })} />

          {/* A scratch pad has no git to keep its line endings. */}
          {!project.scratch && (
            <LineEndingsSection project={project} onOpenChanges={onOpenChanges} />
          )}

          {global && (
            <section aria-labelledby="project-shared-title" className="shared-vars">
              <h3 id="project-shared-title">
                Shared variables <span className="shared-tag">shared</span>
              </h3>
              <p className="shared-note" role="note">
                From {global.name} (<code>{global.uses}/project.yml</code>): a change here applies
                to every project that uses it. This project&rsquo;s own variables of the same name
                override these.
              </p>
              <FileStatus
                label={
                  <>
                    <code>project.yml</code> in {global.name}
                  </>
                }
                file={shared}
                autoSave={autoSave.enabled}
              />
              <div aria-label="Shared variables" role="group">
                <VariablesEditor
                  vars={shared.draft.vars}
                  onChange={(vars) => shared.change({ vars: vars as Vars | undefined })}
                  previews={props.previews}
                  onCopyVariable={props.onCopyVariable}
                />
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  )
}

/**
 * `tls.ca` (SPEC.md §1.1): certificate files that requests trust on top of
 * the system's. Each is shown with what it holds once saved, so a person can
 * see that it is the CA they meant, or why it cannot be used.
 */
function CaSection(props: {
  project: ProjectView
  ca: string[]
  onChange: (ca: string[]) => void
}) {
  const { project, ca, onChange } = props
  const [error, setError] = useState<string | null>(null)
  const saved = (file: string) =>
    project.caFiles.find(
      (entry) => entry.source === 'project' && entry.path === file.trim().replace(/\\/g, '/')
    )
  const shared = project.caFiles.filter((entry) => entry.source === 'global')

  const choose = async () => {
    const result = await window.desktop.projects.pickFile({
      kind: 'certificate',
      projectId: project.id
    })
    if (!result.ok) {
      setError(result.message)
      return
    }
    setError(null)
    if (result.path && !ca.includes(result.path)) onChange([...ca, result.path])
  }

  return (
    <section aria-labelledby="project-ca-title">
      <h3 id="project-ca-title">CA certificates</h3>
      <p className="hint">
        Requests trust the CAs your system trusts, such as the macOS Keychain or the Windows
        certificate store, as well as Node&rsquo;s own. To trust a company or local CA on every
        machine and in <code>gta</code>, add its certificate here, as a PEM or DER file. The path is
        relative to this project and is written to <code>tls.ca</code>.
      </p>
      {ca.length > 0 && (
        <ul className="ca-files" aria-label="CA certificates">
          {ca.map((file, index) => (
            <li key={index}>
              <div className="ca-row">
                <input
                  value={file}
                  placeholder="certs/company-root.pem"
                  aria-label={`CA certificate ${index + 1}`}
                  spellCheck={false}
                  onChange={(e) => onChange(ca.map((f, i) => (i === index ? e.target.value : f)))}
                />
                <Tooltip text="Stop trusting this certificate">
                  <button
                    type="button"
                    className="ca-remove"
                    aria-label={`Remove ${file.trim() || 'this certificate'}`}
                    onClick={() => onChange(ca.filter((_, i) => i !== index))}
                  >
                    &times;
                  </button>
                </Tooltip>
              </div>
              <CaStatus file={saved(file)} />
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => void choose()}>
        Add certificate&hellip;
      </button>
      {error && (
        <p className="setting-error" role="alert">
          {error}
        </p>
      )}
      {shared.length > 0 && project.global && (
        <>
          <p className="hint">
            Also trusted, from {project.global.name} (<code>{project.global.uses}/project.yml</code>
            ):
          </p>
          <ul className="ca-files" aria-label="Shared CA certificates">
            {shared.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code>
                <span className="shared-tag">shared</span>
                <CaStatus file={file} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** What a saved `tls.ca` file holds, or why it cannot be used. */
function CaStatus({ file }: { file: CaFileView | undefined }) {
  if (!file) return null
  if (file.problem) {
    return (
      <p className="setting-error ca-status" role="alert">
        {file.problem}
      </p>
    )
  }
  const now = Date.now()
  return (
    <p className="hint ca-status">
      {file.certificates
        .map((certificate) => {
          const expires = new Date(certificate.expires)
          const date = expires.toLocaleDateString(undefined, { dateStyle: 'medium' })
          return `${certificate.subject} · ${expires.getTime() < now ? 'expired' : 'expires'} ${date}`
        })
        .join('; ')}
    </p>
  )
}

/** Where one file's edits stand: saved, saving, unsaved (with Save), or changed on disk. */
function FileStatus(props: {
  label: React.ReactNode
  file: ReturnType<typeof useProjectFile>
  autoSave: boolean
}) {
  const { file } = props
  return (
    <>
      <p className="hint project-file">
        {props.label}
        {file.status && (
          <span className="save-status" role="status">
            {file.status}
            {file.dirty && !props.autoSave && file.state === 'idle' && (
              <button type="button" onClick={() => void file.save()}>
                Save
              </button>
            )}
          </span>
        )}
      </p>
      {file.state === 'conflict' && (
        <p className="save-status conflict" role="alert">
          It changed on disk.
          <button type="button" onClick={file.reload}>
            Reload
          </button>
        </p>
      )}
      {file.message && (
        <p className="setting-error" role="alert">
          {file.message}
        </p>
      )}
    </>
  )
}
