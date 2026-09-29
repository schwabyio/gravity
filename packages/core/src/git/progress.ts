/**
 * A line of git's `--progress` output, as a phase and a percentage.
 *
 * `Receiving objects:  42% (420/1000), 1.2 MiB | 3.4 MiB/s` → Receiving objects, 42.
 * A line without a percentage — `Cloning into 'x'...` — keeps its text.
 */
export function parseProgress(line: string): { phase: string; percent: number | null } {
  const text = line.replace(/^remote:\s*/, '').trim()
  const match = /^([^:]+):\s+(\d{1,3})%/.exec(text)
  if (match) return { phase: match[1]!.trim(), percent: Number(match[2]) }
  return { phase: text.replace(/\.\.\.$/, ''), percent: null }
}
