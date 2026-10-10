import {
  isReadStep,
  isUseStep,
  type Collection,
  type FlagConditions,
  type FlagValue,
  type StepList,
  type VariablePreviews
} from '@schwabyio/gravity-core/model'
import { stepsOf } from '../hooks/useCollectionEditor.js'
import { showFlagValue, stepFlagState } from '../flagState.js'
import FlagConditionsEditor from './FlagConditionsEditor.js'
import InfoTip from './InfoTip.js'
import StepChip from './StepChip.js'
import VariableInput from './VariableInput.js'

interface Props {
  collection: Collection
  /** The selected step's list and place in it. */
  list: StepList
  index: number
  /** Its own flag conditions, as the editor holds them. */
  flags: FlagConditions
  onFlags: (flags: FlagConditions | undefined) => void
  /** The feature flag values runs use now (SPEC.md §2.9); null when none are known. */
  flagValues: Record<string, FlagValue> | null
  /** Its `forEach`, as the editor holds it (SPEC.md §2.1). */
  forEach: string
  onForEach: (forEach: string) => void
  previews: VariablePreviews
  onCopyVariable: (name: string) => Promise<boolean>
}

/**
 * The selected step's feature flags and `forEach`, as chips on its request bar
 * beside Send: whether Send sends it, and how many times. Each opens its editor.
 */
export default function StepChips(props: Props) {
  const steps = stepsOf(props.collection, props.list)
  const step = steps[props.index]
  if (!step) return null
  const state = stepFlagState(
    { flags: props.collection.flags, steps },
    props.index,
    props.flagValues
  )
  const names = Object.keys(props.flags)
  const needs = names.map((name) => `${name}: ${showFlagValue(props.flags[name]!)}`).join(', ')
  // Only setup and teardown repeat: a list of things to prepare or clean up.
  const repeats =
    props.list !== 'steps' && !isUseStep(step) && !isReadStep(step) && step.connection === undefined
  const place = `${props.list}:${props.index}`

  return (
    <>
      <StepChip
        key={`flags:${place}`}
        className="step-flag-chip"
        set={names.length > 0}
        {...(names.length > 0 ? { tone: state?.kind ?? 'holds' } : {})}
        label={
          names.length === 0
            ? '+ flag'
            : names.length === 1
              ? `⚑ ${needs}`
              : `⚑ ${names.length} flags`
        }
        tooltip={
          names.length === 0
            ? 'Feature flags this step needs: without their values it is skipped, and reported so'
            : state === null
              ? `Needs ${needs}, and runs: they hold`
              : state.kind === 'skip'
                ? `Needs ${needs}. Skipped: ${state.reason}`
                : state.message
        }
        title="Step feature flags"
      >
        <FlagConditionsEditor
          owner="step"
          conditions={props.flags}
          values={props.flagValues}
          onChange={props.onFlags}
          addLabel="+ Add a flag this step needs"
        />
      </StepChip>
      {repeats && (
        <StepChip
          key={`repeat:${place}`}
          className="step-repeat-chip"
          set={props.forEach.trim() !== ''}
          label={props.forEach.trim() === '' ? '+ for each' : `↻ for each ${props.forEach}`}
          tooltip={
            props.forEach.trim() === ''
              ? 'Send this request once for each item of a list'
              : `Sent once for each item of ${props.forEach}`
          }
          title="For each item of a list"
        >
          <div className="foreach-field">
            <VariableInput
              value={props.forEach}
              onChange={props.onForEach}
              previews={props.previews}
              onCopy={props.onCopyVariable}
              placeholder="{{items}}, a variable holding a JSON array, or one written here"
              ariaLabel="Send once for each item of"
            />
            <InfoTip
              about="repeating a request"
              text={
                <>
                  The request is sent once per item, read as <code>{'{{item}}'}</code> and as{' '}
                  <code>item</code> in code: for a list of things setup prepares or teardown cleans
                  up, such as every order the rows made. A list that comes out empty skips the step.
                </>
              }
            />
          </div>
        </StepChip>
      )}
    </>
  )
}
