/** A duration as the app shows one: `84 ms`, `1.20 s`. */
export const formatMs = (ms: number): string =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`

/** A size in bytes as the app shows one: `512 B`, `1.2 KB`. */
export const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
