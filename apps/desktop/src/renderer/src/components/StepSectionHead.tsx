import { Fragment, useState, type ReactNode } from 'react'
import { useMenuDismiss } from '../hooks/useMenuDismiss.js'
import InfoTip from './InfoTip.js'
import MenuIcon from './MenuIcon.js'
import type { AddAction } from './StepList.js'
import Tooltip from './Tooltip.js'

interface Props {
  /** `Steps`, `Setup`, `Teardown`, `Endpoints`. */
  title: string
  /** What its + adds, to the end of the list: groups, a line between each. */
  groups: AddAction[][]
  /** How the list runs, behind an ⓘ beside its name. */
  info?: ReactNode
}

/**
 * A list's heading in the steps pane, and beside its name a + whose menu adds
 * to the end of the list: always in reach at the top, however long the list.
 * A step's own ⋯ adds below that step.
 */
export default function StepSectionHead({ title, groups, info }: Props) {
  const [open, setOpen] = useState(false)
  const menus = useMenuDismiss(open, () => setOpen(false))
  const shown = groups.filter((group) => group.length > 0)
  const what = `Add to ${title.toLowerCase()}`
  const list =
    title === 'Setup' || title === 'Teardown' ? title.toLowerCase() : `the ${title.toLowerCase()}`

  return (
    <div className="step-section-head">
      <h2 className="step-section-title">{title}</h2>
      {info && <InfoTip about={title.toLowerCase()} text={info} />}
      {shown.length > 0 && (
        <span className="project-menu-wrap">
          <Tooltip text={`Add to the end of ${list}`}>
            <button
              type="button"
              className="section-add"
              aria-label={what}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={(event) => {
                event.stopPropagation()
                if (!open) menus.opened()
                setOpen(!open)
              }}
            >
              <MenuIcon name="new" />
            </button>
          </Tooltip>
          {open && (
            <div className="project-menu section-add-menu" role="menu">
              {shown.map((group, i) => (
                <Fragment key={i}>
                  {i > 0 && <div className="menu-divider" role="separator" />}
                  {group.map((add) => (
                    <Fragment key={add.label}>
                      <button
                        type="button"
                        role="menuitem"
                        disabled={add.disabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          setOpen(false)
                          add.onClick()
                        }}
                      >
                        <MenuIcon name={add.icon} />
                        {add.label}
                      </button>
                      {add.disabled && add.note && <p className="menu-note">{add.note}</p>}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </span>
      )}
    </div>
  )
}
