import type { OpenStream } from '../http/stream.js'

/** A connection as the app shows it: its name, the events it holds, and whether it is open. */
export interface ConnectionState {
  name: string
  /** Events arrived and not yet read by a step. */
  held: number
  /** False once the server closed it, or it reached the safety limit. */
  open: boolean
}

/**
 * The connections a run holds open (SPEC.md §2.11): event streams a step
 * opened under a name, for later steps to read.
 *
 * A run owns one: `runSuite` closes every connection when the run ends, and
 * the app keeps one per collection between Sends. Opening a name already in
 * use closes the one before.
 */
export class Connections {
  private readonly streams = new Map<string, OpenStream>()

  /** `changed` hears of every change: a connection opened or closed, an event held or read. */
  constructor(private readonly changed?: (state: ConnectionState[]) => void) {}

  open(name: string, stream: OpenStream): void {
    const before = this.streams.get(name)
    if (before) {
      before.pump.onChange = undefined
      before.close()
    }
    this.streams.set(name, stream)
    stream.pump.onChange = () => this.report()
    this.report()
  }

  get(name: string): OpenStream | undefined {
    return this.streams.get(name)
  }

  /** Close one connection, or with no name every one, and forget them. */
  close(name?: string): void {
    const names = name === undefined ? [...this.streams.keys()] : [name]
    let any = false
    for (const each of names) {
      const stream = this.streams.get(each)
      if (!stream) continue
      stream.pump.onChange = undefined
      stream.close()
      this.streams.delete(each)
      any = true
    }
    if (any) this.report()
  }

  state(): ConnectionState[] {
    return [...this.streams].map(([name, stream]) => ({
      name,
      held: stream.pump.count,
      open: stream.pump.end === null
    }))
  }

  private report(): void {
    this.changed?.(this.state())
  }
}
