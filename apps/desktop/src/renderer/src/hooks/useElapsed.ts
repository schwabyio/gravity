import { useEffect, useState } from 'react'

/** Milliseconds since the component using it was shown, counted every `tick` ms. */
export function useElapsed(tick = 100): number {
  const [started] = useState(() => performance.now())
  const [now, setNow] = useState(started)
  useEffect(() => {
    const timer = setInterval(() => setNow(performance.now()), tick)
    return () => clearInterval(timer)
  }, [tick])
  return now - started
}
