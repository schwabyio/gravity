import { useCallback, useEffect, useState } from 'react'
import {
  DEFAULT_SETTINGS,
  patchSettings,
  type Settings,
  type SettingsPatch
} from '@shared/settings.js'

/**
 * The app's settings, read from main and kept current as they change.
 *
 * Until main answers, the defaults apply — the same values a first launch
 * would get — so nothing waits on settings to render.
 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    void window.desktop.settings.get().then((value) => {
      if (!live) return
      setSettings(value)
      setLoaded(true)
    })
    const off = window.desktop.settings.onChanged(setSettings)
    return () => {
      live = false
      off()
    }
  }, [])

  const change = useCallback(async (patch: SettingsPatch) => {
    // Shown at once, so a switch moves under the click rather than after main
    // answers; main's answer (or the old value, on failure) then settles it.
    let previous: Settings | null = null
    setSettings((current) => {
      previous = current
      return patchSettings(current, patch)
    })
    const result = await window.desktop.settings.set(patch)
    if (result.ok) setSettings(result.settings)
    else if (previous) setSettings(previous)
    return result
  }, [])

  return { settings, loaded, change }
}
