import type { LoadEvent } from '../shared/ipc.js'

/** The most lines kept: past it, the oldest go. */
const MAX_EVENTS = 1000

/**
 * The load log: what the app did to list projects and set git up, kept from
 * the moment it starts — before any window can ask — so the console shows
 * startup too. Each line goes to every window as it is written.
 */
export class LoadLog {
  private readonly events: LoadEvent[] = []
  private readonly listeners = new Set<(event: LoadEvent) => void>()
  private seq = 0

  write(subject: string, text: string, problem = false): void {
    const event: LoadEvent = {
      kind: 'load',
      seq: ++this.seq,
      at: Date.now(),
      subject,
      text,
      ...(problem ? { problem: true } : {})
    }
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.shift()
    for (const listener of this.listeners) listener(event)
  }

  history(): LoadEvent[] {
    return [...this.events]
  }

  onEvent(listener: (event: LoadEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

/** A time as the log says it: `640 ms`, `2.3 s`. */
export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

export const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`
