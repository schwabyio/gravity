import { useEffect, useRef, useState } from 'react'
import { AGENTS_SECTION, type RuleFinding } from '@schwabyio/gravity-core/model'
import type { ProjectView } from '@shared/ipc.js'
import { joinPath } from '../externalEditor.js'
import { findingsLabel } from '../ruleFindings.js'
import Markdown from './Markdown.js'
import OpenInEditor from './OpenInEditor.js'

/** Findings listed here; `gta lint` lists the rest. */
const SHOWN = 100

/** A rule's value as `gta rules` shows it: `[gta, console]`, `off` for null. */
const shownValue = (value: unknown): string =>
  value === null ? 'off' : Array.isArray(value) ? `[${value.join(', ')}]` : String(value)

/**
 * The project's rules (SPEC.md §1.4) in Project settings: each rule set, its
 * value, the file it came from — this project's `rules.yml` or its global
 * project's — and what it means; then where the project's files break them,
 * each opening the file in the app. The rules are edited in `rules.yml`, a
 * click away in the external editor: they are the project's agreement,
 * changed by a reviewed commit rather than in passing.
 */
export default function RulesSection(props: {
  project: ProjectView
  /** Scrolled into view on opening: the drawer was opened for the rules. */
  focus: boolean
  onOpenFinding: (finding: RuleFinding) => void
}) {
  const { project } = props
  const { rules, findings } = project
  const section = useRef<HTMLElement>(null)
  useEffect(() => {
    if (props.focus) section.current?.scrollIntoView({ block: 'start' })
  }, [props.focus])

  const global = project.global
  /** A file of the project, as findings name it with `/`, where it is on disk. */
  const onDisk = (file: string) =>
    file.split('/').reduce((folder, part) => joinPath(folder, part), project.path)
  /** A rules file as `source` names it, where it is on disk. */
  const fileAt = (source: string): string | null =>
    source === 'rules.yml'
      ? joinPath(project.path, 'rules.yml')
      : global
        ? joinPath(global.path, 'rules.yml')
        : null
  const sharedFile = (source: string) => source !== 'rules.yml'

  return (
    <section ref={section} aria-labelledby="project-rules-title" className="rules-section">
      <h3 id="project-rules-title">Rules</h3>
      <p className="hint">
        How this project&rsquo;s files are named, laid out and written, from <code>rules.yml</code>
        {global && <> and {global.name}&rsquo;s under it</>}. A file or step that breaks one is
        marked <span className="rule-mark">△</span> in the sidebar and the step list; nothing stops
        it running. <code>gta lint</code> checks the same in CI.
      </p>
      {rules.problem && (
        <p className="setting-error rules-problem" role="alert">
          {rules.problem}
        </p>
      )}

      {rules.files.length > 0 && (
        <ul className="rules-files" aria-label="Rules files">
          {rules.files.map((source) => (
            <li key={source}>
              <code>{source}</code>
              {sharedFile(source) && <span className="shared-tag">shared</span>}
              <OpenInEditor
                target={fileAt(source) ? { path: fileAt(source)! } : null}
                what={source}
              />
            </li>
          ))}
        </ul>
      )}

      {rules.settings.length === 0 ? (
        !rules.problem && (
          <p className="hint rules-none">
            No <code>rules.yml</code> {global ? <>here or in {global.name}</> : 'here'}. Add one
            beside <code>project.yml</code> to write down this project&rsquo;s conventions: id
            styles, folders, step names and URLs, docs, tags, what tests check, and a guide.
          </p>
        )
      ) : (
        <dl className="rules-list" aria-label="Rules">
          {rules.settings.map((setting) => (
            <div key={setting.rule} className={`rule${setting.on ? '' : ' off'}`}>
              <dt>
                <code className="rule-name">{setting.rule}</code>
                <code className="rule-value">{shownValue(setting.value)}</code>
                <span className="rule-source">
                  {setting.source}
                  {sharedFile(setting.source) && <span className="shared-tag">shared</span>}
                </span>
              </dt>
              <dd className="hint">{setting.doc}</dd>
            </div>
          ))}
        </dl>
      )}

      {rules.guides.map((guide) => (
        <div
          key={guide.source}
          className="rules-guide"
          role="note"
          aria-label={`Guide from ${guide.source}`}
        >
          <h4>
            Guide <span className="rule-source">{guide.source}</span>
            {sharedFile(guide.source) && <span className="shared-tag">shared</span>}
          </h4>
          <Markdown source={guide.text} />
        </div>
      ))}

      {/* A scratch pad is no repository's: no agent works in it. */}
      {!project.scratch && rules.files.length > 0 && (
        <AgentsOffer project={project} file={onDisk('AGENTS.md')} />
      )}

      {findings.length > 0 && (
        <>
          <h4 className="rules-findings-title">{findingsLabel(findings.length)}</h4>
          <ul className="rule-findings" aria-label="Rule findings">
            {findings.slice(0, SHOWN).map((finding, index) => {
              const place = finding.line === null ? finding.file : `${finding.file}:${finding.line}`
              const folder = finding.file.endsWith('/')
              return (
                <li key={index}>
                  <div className="rule-finding-head">
                    {folder ? (
                      <code className="rule-finding-place">{place}</code>
                    ) : (
                      <button
                        type="button"
                        className="link-button rule-finding-place"
                        onClick={() => props.onOpenFinding(finding)}
                        title={`Open ${finding.file} in Gravity`}
                      >
                        {place}
                      </button>
                    )}
                    {!folder && (
                      <OpenInEditor
                        target={{
                          path: onDisk(finding.file),
                          ...(finding.line !== null ? { line: finding.line } : {})
                        }}
                        what={place}
                      />
                    )}
                  </div>
                  <div className="rule-finding-body">
                    {finding.message}
                    {finding.rule && (
                      <span className="rule-finding-rule">
                        {finding.rule} · {finding.source}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          {findings.length > SHOWN && (
            <p className="hint">
              And {findings.length - SHOWN} more: <code>gta lint</code> lists them all.
            </p>
          )}
        </>
      )}
    </section>
  )
}

/**
 * The offer of a section in the project's `AGENTS.md` that points coding
 * agents at its rules: `gta rules` before writing a test, `gta lint` after.
 * Nothing is written until asked; once there, it says so.
 */
function AgentsOffer(props: { project: ProjectView; file: string }) {
  const { agents } = props.project.rules
  const [working, setWorking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const add = async () => {
    setWorking(true)
    setProblem(null)
    const result = await window.desktop.projects.addAgentsSection(props.project.id)
    setWorking(false)
    if (!result.ok) setProblem(result.message)
  }

  return (
    <div className="rules-agents">
      <h4>Coding agents</h4>
      {agents.hasSection ? (
        <p className="hint" role="status">
          This project&rsquo;s <code>AGENTS.md</code> tells coding agents to run{' '}
          <code>gta rules</code> before writing a test here, and <code>gta lint</code> after.
          <OpenInEditor target={{ path: props.file }} what="AGENTS.md" />
        </p>
      ) : (
        <>
          <p className="hint">
            Coding agents read <code>AGENTS.md</code>. A short section there tells them to run{' '}
            <code>gta rules</code> before writing a test here and <code>gta lint --json</code>{' '}
            after, so they keep to these rules too.{' '}
            {agents.exists
              ? 'It goes at the end of the project’s AGENTS.md.'
              : 'It makes an AGENTS.md in the project’s folder.'}
          </p>
          <details className="eol-block">
            <summary>What it adds</summary>
            <pre>{AGENTS_SECTION}</pre>
          </details>
          <button type="button" disabled={working} onClick={() => void add()}>
            Add to AGENTS.md
          </button>
          {problem && (
            <p className="setting-error" role="alert">
              {problem}
            </p>
          )}
        </>
      )}
    </div>
  )
}
