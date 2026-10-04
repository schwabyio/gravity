import { environmentNames, type EnvironmentRef } from '@schwabyio/gravity-core/model'
import PencilIcon from './PencilIcon.js'
import Tooltip from './Tooltip.js'

interface Props {
  environments: EnvironmentRef[]
  selected: string | null
  onChange: (environment: string | null) => void
  /** Open the Environments drawer, from the pencil beside the list. */
  onEdit: () => void
  /** Edits to the environments not saved yet, with auto save off. */
  pending: boolean
}

/**
 * Chooses which `environments/<name>.yml` supplies the variables for a run;
 * the pencil beside it changes them.
 *
 * Shown only when the collection has environments to choose between.
 */
export default function EnvironmentPicker(props: Props) {
  const { environments, selected } = props
  if (environments.length === 0) return null

  const unset = selected === null
  return (
    <div className={`env-picker${unset ? ' unset' : ''}`}>
      <select
        value={selected ?? ''}
        onChange={(event) => props.onChange(event.target.value === '' ? null : event.target.value)}
        aria-label="Environment"
        title={unset ? 'No environment selected — {{variables}} will not resolve' : selected}
      >
        <option value="">No environment</option>
        {/* One entry per name: a project's file and its global project's of the
            same name are one environment. */}
        {environmentNames(environments).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <Tooltip
        text={`Edit environments: their names and variables${props.pending ? ' — some changes are not saved yet' : ''}`}
      >
        <button
          type="button"
          className="env-edit-icon"
          onClick={props.onEdit}
          aria-label={props.pending ? 'Edit environments (unsaved changes)' : 'Edit environments'}
        >
          <PencilIcon size={18} />
          {props.pending && <span className="env-pending" aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  )
}
