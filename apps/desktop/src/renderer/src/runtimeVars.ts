import type { RuntimeVariable, RuntimeVariablesView } from '@shared/ipc.js'

/** What set a value, as the Variables tab says it: `login · captured · row 2`. */
export const setByLabel = (variable: RuntimeVariable): string =>
  [variable.step, variable.by, variable.row].filter(Boolean).join(' · ')

/** Where the values came from, above them: `Run all · demo · 12:04:31`. */
export function runtimeSummary(view: RuntimeVariablesView): string {
  const date = new Date(view.at)
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':')
  return [
    view.last === 'run' ? 'Run all' : 'Sends',
    view.environment ?? 'no environment',
    time
  ].join(' · ')
}

/** The values whose name, value or setter has the text in it, any case. */
export function filterVariables(variables: RuntimeVariable[], query: string): RuntimeVariable[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return variables
  return variables.filter((variable) =>
    [variable.name, variable.value ?? '', setByLabel(variable)].some((text) =>
      text.toLowerCase().includes(wanted)
    )
  )
}
