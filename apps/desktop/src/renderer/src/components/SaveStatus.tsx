import type { SaveStatus as Status } from '../hooks/useCollectionEditor.js'

interface Props {
  status: Status
  autoSave: boolean
  onSave: () => void
  onReload: () => void
  onKeepMine: () => void
}

/**
 * Where the open collection's edits stand, beside its name in the app bar.
 *
 * With auto save on, "Unsaved changes" is only ever momentary, so it is shown
 * quietly; with it off, it carries the Save button.
 */
export default function SaveStatus({ status, autoSave, onSave, onReload, onKeepMine }: Props) {
  switch (status.kind) {
    case 'saved':
      return (
        <span className="save-status saved" role="status">
          Saved
        </span>
      )
    case 'saving':
      return (
        <span className="save-status saving" role="status">
          Saving…
        </span>
      )
    case 'unsaved':
      return (
        <span className="save-status unsaved" role="status">
          {autoSave ? 'Editing…' : `${status.count} unsaved change${status.count === 1 ? '' : 's'}`}
          {!autoSave && (
            <button type="button" onClick={onSave}>
              Save
            </button>
          )}
        </span>
      )
    case 'failed':
      return (
        <span className="save-status failed" role="alert" title={status.message}>
          Save failed: {status.message}
          <button type="button" onClick={onSave}>
            Retry
          </button>
        </span>
      )
    case 'conflict':
      return (
        <span className="save-status conflict" role="alert">
          Changed on disk
          <button type="button" onClick={onReload}>
            Reload
          </button>
          <button type="button" onClick={onKeepMine}>
            Keep mine
          </button>
        </span>
      )
  }
}
