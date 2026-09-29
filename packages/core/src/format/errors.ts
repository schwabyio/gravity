import type { z } from 'zod'

/** A file that could not be read as part of the format, with the path attached. */
export class FormatError extends Error {
  constructor(
    message: string,
    readonly file: string | undefined,
    override readonly cause?: unknown
  ) {
    super(file ? `${file}: ${message}` : message)
    this.name = 'FormatError'
  }
}

/** Turn a zod failure into something a person can act on. */
export function describeValidation(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}
