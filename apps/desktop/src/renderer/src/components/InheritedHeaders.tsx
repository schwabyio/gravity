import type { Headers } from '@schwabyio/gravity-core/model'
import { isHeaderEnabled } from '@schwabyio/gravity-core/model'
import { replacedBy, type InheritedLayer } from '../inheritance.js'

interface Props {
  /** Every layer the step inherits, outermost first. */
  layers: InheritedLayer[]
  /** The step's own headers, to show which inherited ones they replace. */
  own: Headers | undefined
  /** Open where a layer's headers are written. */
  onOpen: (layer: InheritedLayer) => void
}

/**
 * The headers a step sends without saying so, under its own, read-only: each
 * layer's that has any, outermost first — the endpoints file's, the
 * endpoint's, the base collection's, the collection's — and which of them a
 * nearer layer, or the step, replaces.
 */
export default function InheritedHeaders({ layers, own, onOpen }: Props) {
  return (
    <>
      {layers.map((layer, index) => {
        const entries = Object.entries(layer.headers ?? {}).flatMap(([name, value]) =>
          typeof value === 'string'
            ? [{ name, value, on: true }]
            : Array.isArray(value)
              ? value.map((item) => ({ name, value: item, on: true }))
              : [{ name, value: value.value, on: isHeaderEnabled(value) }]
        )
        if (entries.length === 0) return null
        const collection = layer.kind === 'collection'
        return (
          <section
            key={layer.kind}
            className={`inherited-headers${layer.used ? '' : ' unused-layer'}`}
            aria-label={`Headers from the ${layer.title}`}
          >
            <div className="inherited-head">
              <span>
                From the {layer.title}
                {layer.name && (
                  <>
                    {' '}
                    <code className="layer-name">{layer.name}</code>
                  </>
                )}
                {layer.shared && <span className="shared-tag">shared</span>}
                {!layer.used && <span className="layer-off">not used by this step</span>}
              </span>
              <button
                type="button"
                className="link"
                onClick={() => onOpen(layer)}
                aria-label={
                  collection
                    ? 'Edit the collection’s headers'
                    : `Open the ${layer.title} ${layer.name ?? ''}`.trim()
                }
              >
                {collection ? 'Edit' : 'Open'}
              </button>
            </div>
            <table className="kv readonly">
              <tbody>
                {entries.map(({ name, value, on }, row) => {
                  const by = layer.used && on ? replacedBy(layers, index, name, own) : null
                  const note = !layer.used ? 'not used' : by ? `replaced by ${by}` : on ? '' : 'off'
                  return (
                    <tr key={`${name}-${row}`} className={by || !on || !layer.used ? 'unused' : ''}>
                      <td className="header-name">{name}</td>
                      <td className="wrap">{value}</td>
                      <td className="inherited-note">{note}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )
      })}
    </>
  )
}
