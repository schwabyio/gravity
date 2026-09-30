import { useState } from 'react'
import {
  groupByDirectory,
  type CollectionNode,
  type CollectionSummary
} from '@schwabyio/gravity-core/model'

interface Props {
  collections: CollectionSummary[]
  /** Directories inside `collections/`, shown even while empty. */
  directories: string[]
  selectedPath: string | null
  onSelect: (collection: CollectionSummary) => void
  /** Every directory shown open, as while a filter narrows the list. */
  expanded?: boolean
}

/**
 * A project's collections: each directory, one level deep, with the
 * collections in it, then those at the root of `collections/`. The
 * `collections/` segment every path shares is never shown.
 */
export default function CollectionList({
  collections,
  directories,
  selectedPath,
  onSelect,
  expanded = false
}: Props) {
  return (
    <>
      {groupByDirectory(collections, directories).map((node) =>
        node.kind === 'directory' ? (
          <Directory
            key={`dir:${node.name}`}
            node={node}
            selectedPath={selectedPath}
            onSelect={onSelect}
            expanded={expanded}
          />
        ) : (
          <CollectionRow
            key={node.summary.path}
            summary={node.summary}
            depth={0}
            selected={node.summary.path === selectedPath}
            onSelect={onSelect}
          />
        )
      )}
    </>
  )
}

function CollectionRow(props: {
  summary: CollectionSummary
  depth: number
  selected: boolean
  onSelect: Props['onSelect']
}) {
  const { summary } = props
  return (
    <button
      className={`row collection-row${props.selected ? ' selected' : ''}${summary.excluded ? ' excluded' : ''}`}
      style={{ paddingLeft: 22 + props.depth * 14 }}
      onClick={() => props.onSelect(summary)}
      title={
        summary.excluded
          ? `${summary.relativePath} — excluded from group runs`
          : summary.relativePath
      }
    >
      <span className="label">{summary.name}</span>
      {/* Only a problem, or being left out of group runs, is worth a mark here.
          The step count is on the collection itself, a click away. */}
      {summary.dataFile && (
        <span
          className="data-mark"
          aria-label={`data file, ${summary.dataFile.rows} rows`}
          title={`Runs once per row of ${summary.dataFile.relativePath} (${summary.dataFile.rows})`}
        >
          ×{summary.dataFile.rows}
        </span>
      )}
      {summary.excluded && (
        <span className="excluded-mark" aria-label="excluded from group runs">
          ⊘
        </span>
      )}
      {summary.problems.length > 0 && (
        <span className="problem" title={summary.problems.map((p) => p.message).join('\n')}>
          !
        </span>
      )}
    </button>
  )
}

function Directory(props: {
  node: Extract<CollectionNode, { kind: 'directory' }>
  selectedPath: string | null
  onSelect: Props['onSelect']
  expanded: boolean
}) {
  const [chosen, setOpen] = useState(true)
  // A filter shows what it found, whatever was collapsed; clearing it restores the choice.
  const open = chosen || props.expanded
  const { node } = props
  return (
    <>
      <button
        className="row group-row"
        style={{ paddingLeft: 14 }}
        onClick={() => setOpen(!chosen)}
        aria-expanded={open}
      >
        <span className="chevron">{open ? '▾' : '▸'}</span>
        <span className="label">{node.name}</span>
      </button>
      {open &&
        (node.children.length === 0 ? (
          <p className="hint directory-empty">No collections yet</p>
        ) : (
          node.children.map(
            (child) =>
              child.kind === 'collection' && (
                <CollectionRow
                  key={child.summary.path}
                  summary={child.summary}
                  depth={1}
                  selected={child.summary.path === props.selectedPath}
                  onSelect={props.onSelect}
                />
              )
          )
        ))}
    </>
  )
}
