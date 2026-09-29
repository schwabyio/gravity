import { environmentNames, type EnvironmentRef } from '@schwabyio/gravity-core/model'

interface Props {
  environments: EnvironmentRef[]
  selected: string | null
  onChange: (environment: string | null) => void
}

/**
 * Chooses which `environments/<name>.yml` supplies the variables for a run.
 *
 * Shown only when the collection has environments to choose between.
 */
export default function EnvironmentPicker({ environments, selected, onChange }: Props) {
  if (environments.length === 0) return null

  const unset = selected === null
  return (
    <label className={`env-picker${unset ? ' unset' : ''}`}>
      <select
        value={selected ?? ''}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
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
    </label>
  )
}
