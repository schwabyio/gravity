import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  BranchView,
  ChangedFileView,
  ChangeKindView,
  FileDiffView,
  Ok,
  ProjectView,
  RepoChangesView,
  Result
} from '@shared/ipc.js'
import { diverged, pullState, pushState, rebaseQuestion } from '../gitActions.js'
import { useRepoChanges, type GitFailure } from '../hooks/useRepoChanges.js'
import NameForm from './NameForm.js'
import Tooltip from './Tooltip.js'

interface Props {
  /** The project it was opened from: every call names it, and git finds its repository. */
  project: ProjectView
  initialTab: 'changes' | 'history'
  onClose: () => void
}

const CODES: Record<ChangeKindView, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  untracked: 'U',
  conflicted: '!'
}

const KIND_NAMES: Record<ChangeKindView, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  typechange: 'type changed',
  untracked: 'new, not in git yet',
  conflicted: 'conflicted'
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/**
 * One repository's git: what changed, a commit of the files chosen, branches,
 * and pulling and pushing — for testers, not git experts.
 *
 * Every changed file in the repository is listed, so nothing is committed
 * blind; gta's own files in the app's projects start checked, everything else
 * — a service's source code, a README — starts unchecked. Only what is checked
 * is committed.
 */
export default function ChangesDrawer({ project, initialTab, onClose }: Props) {
  const panel = useRef<HTMLElement>(null)
  const repo = useRepoChanges(project.id, project.repoRoot)
  const { changes } = repo
  const [tab, setTab] = useState(initialTab)
  const [working, setWorking] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [branches, setBranches] = useState<BranchView[]>([])
  const [naming, setNaming] = useState(false)
  const [remote, setRemote] = useState<string | null>(null)
  const [identity, setIdentity] = useState({ name: '', email: '' })
  const [crlf, setCrlf] = useState<{ projectId: string; name: string; count: number } | null>(null)
  const busy = working || project.busy

  useEffect(() => panel.current?.focus(), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !naming) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, naming])

  // Branches move with the repository: reread them whenever its changes are.
  useEffect(() => {
    if (!changes) return
    void window.desktop.git.branches(project.id).then((result) => {
      if (result.ok) setBranches(result.branches)
    })
  }, [changes, project.id])

  useEffect(() => {
    if (tab === 'history' && changes) void repo.loadHistory()
    // The history follows the repository, not each render.
  }, [tab, changes])

  useEffect(() => {
    if (!changes) return
    setIdentity((current) => ({
      name: current.name || changes.identity.name || '',
      email: current.email || changes.identity.email || ''
    }))
  }, [changes])

  /** Run one git action: busy while it runs, its failure shown, the view reread after. */
  const act = useCallback(
    async <T extends object>(
      call: () => Promise<Result<T>>,
      done?: (result: Ok<T>) => void
    ): Promise<boolean> => {
      setWorking(true)
      repo.setFailure(null)
      setNotice(null)
      try {
        const result = await call()
        if (!result.ok) {
          repo.setFailure({ message: result.message, hint: result.hint })
          return false
        }
        done?.(result)
        return true
      } finally {
        setWorking(false)
        void repo.load()
      }
    },
    [repo.load, repo.setFailure]
  )

  if (!changes) {
    return (
      <Shell panel={panel} title={project.name} onClose={onClose}>
        <div className="drawer-body">
          {repo.failure ? <Failure failure={repo.failure} /> : <p className="hint">Reading git…</p>}
        </div>
      </Shell>
    )
  }

  const { status } = changes
  const checked = changes.files.filter(repo.isChecked)
  const needsIdentity = !changes.identity.name || !changes.identity.email
  const pull = pullState(status, busy)
  const push = pushState(status, busy, remote)
  const blocked = status.operation !== null || status.conflicted > 0 || status.detached
  const canCommit =
    !busy &&
    !blocked &&
    checked.length > 0 &&
    repo.message.trim() !== '' &&
    (!needsIdentity || (identity.name.trim() !== '' && identity.email.trim() !== ''))

  const commit = async () => {
    const secrets = checked.filter((file) => file.secret).map((file) => file.path)
    if (
      secrets.length > 0 &&
      !window.confirm(
        `${secrets.join(', ')} holds secret values and is not meant to be committed. Commit it anyway?`
      )
    ) {
      return
    }
    if (needsIdentity) {
      const saved = await act(() =>
        window.desktop.git.setIdentity(project.id, identity.name, identity.email)
      )
      if (!saved) return
    }
    const paths = checked.map((file) => file.path)
    await act(
      () => window.desktop.git.commit(project.id, paths, repo.message),
      (result) => {
        setNotice(`Committed ${result.shortOid} to ${status.branch ?? 'HEAD'}.`)
        repo.setMessage('')
        repo.settle(paths)
      }
    )
  }

  const discard = async (file: ChangedFileView) => {
    const question =
      file.kind === 'untracked'
        ? `Delete ${file.path}? It is not in git yet, so it moves to the Trash.`
        : file.kind === 'added'
          ? `Remove ${file.path}? It is new, so it moves to the Trash.`
          : `Discard your changes to ${file.path}? Your version moves to the Trash.`
    if (!window.confirm(question)) return
    await act(
      () => window.desktop.git.discard(project.id, file.path),
      () => {
        setNotice(`Discarded ${file.path}.`)
        repo.settle([file.path])
        if (repo.selected === file.path) repo.select(null)
      }
    )
  }

  const doPull = () => {
    if (diverged(status) && !window.confirm(rebaseQuestion(status))) return
    void act(
      () => window.desktop.git.pull(project.id),
      (result) => setNotice(result.message)
    )
  }

  const current = branches.find((branch) => branch.current)
  const branchValue = status.detached ? '' : `local:${current?.name ?? status.branch ?? ''}`

  return (
    <Shell panel={panel} title={changes.repoName} onClose={onClose} className="changes-drawer">
      <div className="changes-bar">
        <select
          aria-label="Branch"
          value={branchValue}
          disabled={busy}
          onChange={(event) => {
            const [kind, ...rest] = event.target.value.split(':')
            const value = rest.join(':')
            const target =
              kind === 'remote'
                ? branches.find(
                    (branch) => branch.remote && `${branch.remote}/${branch.name}` === value
                  )
                : branches.find((branch) => !branch.remote && branch.name === value)
            if (!target) return
            void act(
              () => window.desktop.git.switchBranch(project.id, target.name, target.remote),
              () => setNotice(`Switched to ${target.name}.`)
            )
          }}
        >
          {status.detached && (
            <option value="" disabled>
              detached HEAD
            </option>
          )}
          {!current && status.branch && (
            <option value={`local:${status.branch}`}>{status.branch}</option>
          )}
          {branches
            .filter((branch) => !branch.remote)
            .map((branch) => (
              <option key={branch.name} value={`local:${branch.name}`}>
                {branch.name}
              </option>
            ))}
          {branches.some((branch) => branch.remote) && (
            <optgroup label="Remote branches">
              {branches
                .filter((branch) => branch.remote)
                .map((branch) => (
                  <option
                    key={`${branch.remote}/${branch.name}`}
                    value={`remote:${branch.remote}/${branch.name}`}
                  >
                    {branch.remote}/{branch.name}
                  </option>
                ))}
            </optgroup>
          )}
        </select>
        <Tooltip text="Create a branch from here and switch to it; your changes come along">
          <button type="button" onClick={() => setNaming(true)} disabled={busy || naming}>
            + Branch
          </button>
        </Tooltip>
        <span className="changes-bar-actions">
          <Tooltip text="Fetch from the remote">
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => window.desktop.git.fetch(project.id))}
            >
              Fetch
            </button>
          </Tooltip>
          <Tooltip text={pull.tooltip}>
            <button type="button" disabled={!pull.enabled} onClick={doPull}>
              Pull{pull.count > 0 ? ` ↓${pull.count}` : ''}
            </button>
          </Tooltip>
          {(!status.upstream || status.upstreamGone) && status.remotes.length > 1 && (
            <select
              aria-label="Remote to publish to"
              value={remote ?? (status.remotes.includes('origin') ? 'origin' : status.remotes[0])}
              onChange={(event) => setRemote(event.target.value)}
            >
              {status.remotes.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
          )}
          <Tooltip text={push.tooltip}>
            <button
              type="button"
              disabled={!push.enabled}
              onClick={() =>
                void act(
                  () => window.desktop.git.push(project.id, remote),
                  (result) => setNotice(result.message)
                )
              }
            >
              {!status.upstream || status.upstreamGone
                ? 'Publish'
                : `Push${push.count > 0 ? ` ↑${push.count}` : ''}`}
            </button>
          </Tooltip>
        </span>
      </div>

      {naming && (
        <NameForm
          label="New branch name"
          placeholder="feature/checkout-tests"
          submitLabel="Create"
          onSubmit={async (name) => {
            const result = await window.desktop.git.createBranch(project.id, name)
            if (!result.ok) return result.message
            setNaming(false)
            setNotice(`Created ${name}, and switched to it.`)
            void repo.load()
            return null
          }}
          onCancel={() => setNaming(false)}
        />
      )}

      <Banners changes={changes} />

      {changes.lineEndingNotices.map((item) => (
        <div key={item.projectId} className="git-notice" role="note">
          <span>
            <strong>{item.name}</strong>: git may store its files with Windows (CRLF) line endings.
            A <code>.gitattributes</code> rule for the project&rsquo;s own files keeps them LF on
            every platform.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => window.desktop.git.addAttributes(item.projectId),
                (result) => {
                  const count = result.lineEndings.crlfFiles.length
                  setNotice(`Added .gitattributes to ${item.name}: commit it with your changes.`)
                  setCrlf(count > 0 ? { projectId: item.projectId, name: item.name, count } : null)
                }
              )
            }
          >
            Add .gitattributes
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() =>
              void window.desktop.git.dismissLineEndings(item.projectId).then(() => repo.load())
            }
          >
            Not now
          </button>
        </div>
      ))}
      {crlf && (
        <div className="git-notice" role="note">
          <span>
            {plural(crlf.count, 'file')} in {crlf.name} {crlf.count === 1 ? 'is' : 'are'} stored
            with CRLF line endings.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(
                () => window.desktop.git.convertToLf(crlf.projectId),
                (result) => {
                  setNotice(
                    `Converted ${plural(result.files.length, 'file')} to LF: commit them below.`
                  )
                  setCrlf(null)
                }
              )
            }
          >
            Convert to LF
          </button>
        </div>
      )}

      {repo.failure && <Failure failure={repo.failure} />}
      {notice && !repo.failure && (
        <p className="git-status" role="status">
          {notice}
        </p>
      )}

      <div className="tabs drawer-tabs changes-tabs" role="group" aria-label="Changes view">
        <button
          type="button"
          className={tab === 'changes' ? 'active' : ''}
          aria-pressed={tab === 'changes'}
          onClick={() => setTab('changes')}
        >
          Changes ({changes.files.length})
        </button>
        <button
          type="button"
          className={tab === 'history' ? 'active' : ''}
          aria-pressed={tab === 'history'}
          onClick={() => setTab('history')}
        >
          History
        </button>
      </div>

      {tab === 'changes' ? (
        <div className="drawer-body changes-body">
          <div className="changes-list">
            {changes.files.length === 0 ? (
              <p className="hint empty">No changes: everything is committed.</p>
            ) : (
              <FileGroups
                changes={changes}
                isChecked={repo.isChecked}
                setChecked={repo.setChecked}
                selected={repo.selected}
                onSelect={repo.select}
                onDiscard={(file) => void discard(file)}
                busy={busy}
              />
            )}

            <div className="commit-box">
              {needsIdentity && (
                <div className="identity-fields" role="group" aria-label="Your git identity">
                  <p className="hint">
                    git records a name and email with every commit. They are saved to your global
                    git config, as <code>git config --global</code> would.
                  </p>
                  <input
                    aria-label="Your name"
                    placeholder="Your name"
                    value={identity.name}
                    onChange={(event) => setIdentity({ ...identity, name: event.target.value })}
                  />
                  <input
                    aria-label="Your email"
                    placeholder="you@example.com"
                    type="email"
                    value={identity.email}
                    onChange={(event) => setIdentity({ ...identity, email: event.target.value })}
                  />
                </div>
              )}
              <textarea
                aria-label="Commit message"
                placeholder="What changed, and why"
                rows={3}
                value={repo.message}
                onChange={(event) => repo.setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) {
                    event.preventDefault()
                    void commit()
                  }
                }}
              />
              <button
                type="button"
                className="primary"
                disabled={!canCommit}
                onClick={() => void commit()}
              >
                Commit {plural(checked.length, 'file')}
                {status.branch ? ` to ${status.branch}` : ''}
              </button>
            </div>
          </div>

          <DiffPane
            file={changes.files.find((file) => file.path === repo.selected) ?? null}
            diff={repo.diff}
          />
        </div>
      ) : (
        <div className="drawer-body">
          <History
            history={repo.history}
            showPushed={status.remotes.length > 0}
            onMore={() => void repo.loadHistory(true)}
          />
        </div>
      )}
    </Shell>
  )
}

function Shell(props: {
  panel: React.RefObject<HTMLElement | null>
  title: string
  className?: string
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <>
      <div className="drawer-scrim" onClick={props.onClose} />
      <aside
        ref={props.panel}
        className={`drawer ${props.className ?? ''}`}
        role="dialog"
        aria-label="Changes"
        tabIndex={-1}
      >
        <header className="drawer-head">
          <h2>
            {props.title} <span className="data-file-name">git</span>
          </h2>
          <button type="button" className="drawer-close" onClick={props.onClose} aria-label="Close">
            ×
          </button>
        </header>
        {props.children}
      </aside>
    </>
  )
}

function Failure({ failure }: { failure: GitFailure }) {
  return (
    <div className="git-failure" role="alert">
      <p className="git-failure-message">{failure.message}</p>
      {failure.hint && <p className="git-failure-hint">{failure.hint}</p>}
    </div>
  )
}

/** What stops commits, pulls and pushes in this repository, if anything. */
function Banners({ changes }: { changes: RepoChangesView }) {
  const { status } = changes
  const lines: string[] = []
  if (status.operation) {
    lines.push(
      `A ${status.operation} is in progress in this repository. Finish or abort it in your git tool; until then the app will not commit, pull or push.`
    )
  } else if (status.conflicted > 0) {
    lines.push('This repository has unresolved conflicts. Resolve them in your git tool first.')
  }
  if (status.detached) {
    lines.push('HEAD is detached: create a branch to commit your changes to.')
  }
  if (changes.truncated) {
    lines.push(`Only the first ${changes.files.length} changed files are listed.`)
  }
  return (
    <>
      {lines.map((line) => (
        <p key={line} className="git-banner" role="alert">
          {line}
        </p>
      ))}
    </>
  )
}

function FileGroups(props: {
  changes: RepoChangesView
  isChecked: (file: ChangedFileView) => boolean
  setChecked: (paths: string[], checked: boolean) => void
  selected: string | null
  onSelect: (path: string) => void
  onDiscard: (file: ChangedFileView) => void
  busy: boolean
}) {
  const { changes } = props
  const groups = [
    ...changes.projects.map((project) => ({
      key: project.id,
      name: project.name,
      base: project.path === '.' ? '' : `${project.path}/`,
      files: changes.files.filter((file) => file.projectId === project.id)
    })),
    {
      key: 'elsewhere',
      name: `Elsewhere in ${changes.repoName}`,
      base: '',
      files: changes.files.filter((file) => file.projectId === null)
    }
  ].filter((group) => group.files.length > 0)

  return (
    <>
      {groups.map((group) => {
        const count = group.files.filter(props.isChecked).length
        return (
          <section key={group.key} className="change-group" aria-label={group.name}>
            <label className="change-group-head">
              <GroupCheckbox
                label={`Include every change in ${group.name}`}
                checked={count === group.files.length}
                mixed={count > 0 && count < group.files.length}
                onChange={(checked) =>
                  props.setChecked(
                    group.files.map((file) => file.path),
                    checked
                  )
                }
              />
              <span className="change-group-name">{group.name}</span>
              {group.base && <span className="change-group-path">{group.base}</span>}
            </label>
            <ul className="change-rows">
              {group.files.map((file) => {
                const shown = file.path.startsWith(group.base)
                  ? file.path.slice(group.base.length)
                  : file.path
                const slash = shown.lastIndexOf('/')
                return (
                  <li
                    key={file.path}
                    className={`change-row${props.selected === file.path ? ' selected' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={props.isChecked(file)}
                      aria-label={`Include ${file.path}`}
                      onChange={(event) => props.setChecked([file.path], event.target.checked)}
                    />
                    <button
                      type="button"
                      className="change-name"
                      title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                      aria-label={`${file.path}, ${KIND_NAMES[file.kind]}`}
                      aria-pressed={props.selected === file.path}
                      onClick={() => props.onSelect(file.path)}
                    >
                      <span className={`change-code ${file.kind}`} aria-hidden="true">
                        {CODES[file.kind]}
                      </span>
                      {slash >= 0 && (
                        <span className="change-dir">{shown.slice(0, slash + 1)}</span>
                      )}
                      <span className="change-file">{shown.slice(slash + 1)}</span>
                      {file.secret && <span className="secret-tag">secret</span>}
                    </button>
                    {file.kind !== 'conflicted' && !file.submodule && (
                      <Tooltip text="Discard: put it back as the last commit has it">
                        <button
                          type="button"
                          className="change-discard"
                          aria-label={`Discard changes to ${file.path}`}
                          disabled={props.busy}
                          onClick={() => props.onDiscard(file)}
                        >
                          ↺
                        </button>
                      </Tooltip>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </>
  )
}

function GroupCheckbox(props: {
  label: string
  checked: boolean
  mixed: boolean
  onChange: (checked: boolean) => void
}) {
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = props.mixed
  }, [props.mixed])
  return (
    <input
      ref={box}
      type="checkbox"
      aria-label={props.label}
      checked={props.checked}
      onChange={(event) => props.onChange(event.target.checked)}
    />
  )
}

function DiffPane({ file, diff }: { file: ChangedFileView | null; diff: FileDiffView | null }) {
  if (!file) {
    return (
      <div className="diff-pane">
        <p className="hint empty">Choose a file to see what changed.</p>
      </div>
    )
  }
  return (
    <section className="diff-pane" role="region" aria-label={`Changes to ${file.path}`}>
      <p className="diff-title">
        <span className={`change-code ${file.kind}`}>{CODES[file.kind]}</span> {file.path}
        {file.origPath && <span className="hint"> (renamed from {file.origPath})</span>}
      </p>
      {!diff ? (
        <p className="hint">Reading…</p>
      ) : diff.binary ? (
        <p className="hint">A binary file: there are no lines to show.</p>
      ) : diff.tooLarge ? (
        <p className="hint">Too large to show here.</p>
      ) : diff.hunks.length === 0 ? (
        <p className="hint">No line changes{file.origPath ? ': renamed only' : ''}.</p>
      ) : (
        <table className="diff-table">
          <tbody>
            {diff.hunks.map((hunk, index) => (
              <HunkRows key={`${index}-${hunk.header}`} hunk={hunk} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function HunkRows({ hunk }: { hunk: FileDiffView['hunks'][number] }) {
  return (
    <>
      <tr className="diff-hunk">
        <td colSpan={3}>{hunk.header}</td>
      </tr>
      {hunk.lines.map((line, index) => {
        const cr = line.text.endsWith('\r')
        return (
          <tr key={index} className={`diff-line ${line.kind}`}>
            <td className="diff-ln">{line.oldLine ?? ''}</td>
            <td className="diff-ln">{line.newLine ?? ''}</td>
            <td className="diff-code">
              <span className="diff-marker">
                {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
              </span>
              {cr ? line.text.slice(0, -1) : line.text}
              {cr && (
                <span className="diff-cr" title="A Windows (CRLF) line ending">
                  ␍
                </span>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60]
]

function ago(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return relative.format(0, 'second')
}

function History(props: {
  history: ReturnType<typeof useRepoChanges>['history']
  showPushed: boolean
  onMore: () => void
}) {
  const { history } = props
  if (!history) return <p className="hint">Reading the history…</p>
  if (history.commits.length === 0) return <p className="hint empty">No commits yet.</p>
  return (
    <>
      <ol className="history" aria-label="Recent commits">
        {history.commits.map((commit) => (
          <li key={commit.oid} className="history-row">
            <code className="history-oid">{commit.shortOid}</code>
            <span className="history-subject">{commit.subject}</span>
            {props.showPushed && !commit.pushed && (
              <Tooltip text="Not pushed yet">
                <span className="unpushed" role="img" aria-label="Not pushed yet">
                  ↑
                </span>
              </Tooltip>
            )}
            <span className="history-meta" title={`${commit.email} · ${commit.date}`}>
              {commit.author} · {ago(commit.date)}
            </span>
          </li>
        ))}
      </ol>
      {history.hasMore && (
        <button type="button" className="quiet" onClick={props.onMore}>
          Show more
        </button>
      )}
    </>
  )
}
