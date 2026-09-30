import type { InheritedLayer } from '../inheritance.js'

/**
 * The scripts that run around a step before its own, in order (SPEC.md
 * §2.6): each layer's `before.script`, or its `tests`, with a way to each.
 */
export default function InheritedScripts(props: {
  kind: 'pre-request' | 'tests'
  layers: InheritedLayer[]
  onOpen: (layer: InheritedLayer) => void
}) {
  const { kind } = props
  const running = props.layers.filter((layer) =>
    ((kind === 'pre-request' ? layer.before?.script : layer.tests) ?? '').trim()
  )
  if (running.length === 0) return null
  const what = kind === 'pre-request' ? 'pre-request script' : 'tests'
  const yields = kind === 'tests' && running.some((layer) => layer.endpoint && layer.used)
  return (
    <div
      className="collection-script-note"
      role="note"
      aria-label={
        kind === 'pre-request' ? 'Scripts before this step’s' : 'Tests before this step’s'
      }
    >
      {kind === 'pre-request'
        ? 'Before this step’s script, these run in order:'
        : 'After the response, before this step’s tests, these run in order:'}
      <ol>
        {running.map((layer) => (
          <li key={layer.kind} className={layer.used ? '' : 'unused'}>
            the {layer.title}&rsquo;s
            {layer.name && (
              <>
                {' '}
                <code className="layer-name">{layer.name}</code>
              </>
            )}
            {layer.shared && <span className="shared-tag">shared</span>}
            {!layer.used && <span className="layer-off">not used by this step</span>}{' '}
            <button
              type="button"
              className="link"
              onClick={() => props.onOpen(layer)}
              aria-label={`Open the ${layer.title}’s ${what}`}
            >
              Open
            </button>
          </li>
        ))}
      </ol>
      {yields && (
        <span>
          The endpoint base&rsquo;s checks give way to this step&rsquo;s own checks of the same
          thing.
        </span>
      )}
    </div>
  )
}
