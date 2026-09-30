import { describe, expect, it } from 'vitest'
import { addedMessage, clonedMessage } from './useProjects.js'

describe('what adding a folder’s projects says', () => {
  it('names what it added, and counts what was there already', () => {
    expect(addedMessage('/code/platform', ['auth', 'users'], [])).toBe(
      'Added 2 projects from platform: auth, users.'
    )
    expect(addedMessage('C:\\code\\platform\\', ['auth'], ['users'])).toBe(
      'Added 1 project from platform: auth. 1 more was here already.'
    )
    expect(addedMessage('/code/platform', ['auth'], ['users', 'shared'])).toBe(
      'Added 1 project from platform: auth. 2 more were here already.'
    )
    expect(addedMessage('/code/platform', [], ['auth'])).toBe(
      'The project in platform was here already.'
    )
    expect(addedMessage('/code/platform', [], ['auth', 'users'])).toBe(
      'All 2 projects in platform were here already.'
    )
  })
})

describe('what a clone says', () => {
  it('names the clone and what it added', () => {
    expect(clonedMessage('/code/platform', ['auth', 'users', 'Shared'])).toBe(
      'Cloned platform and added 3 projects: auth, users, Shared.'
    )
    expect(clonedMessage('C:\\code\\payments-api', ['payments-api'])).toBe(
      'Cloned payments-api and added 1 project: payments-api.'
    )
  })
})
