import { describe, expect, it } from 'vitest'
import { parseArgs, UsageError } from './args.js'

describe('parseArgs', () => {
  it('reads a command and settings in both spellings', () => {
    expect(parseArgs(['all', '--limitConcurrency', '4', '--environmentType=staging'])).toEqual({
      command: 'all',
      overrides: { limitConcurrency: '4', environmentType: 'staging' },
      help: false,
      version: false,
      json: false,
      flags: []
    })
  })

  it('takes a bare flag, or one followed by another flag, as true', () => {
    expect(parseArgs(['all', '--bail']).overrides).toEqual({ bail: true })
    expect(parseArgs(['--bail', '--tags', 'smoke', 'get'])).toMatchObject({
      command: 'get',
      overrides: { bail: true, tags: 'smoke' }
    })
  })

  it('takes --json as an option, not a setting', () => {
    expect(parseArgs(['all', '--json', '--bail'])).toMatchObject({
      command: 'all',
      json: true,
      overrides: { bail: true }
    })
  })

  it('has no command when none is given', () => {
    expect(parseArgs([]).command).toBeNull()
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-v']).version).toBe(true)
  })

  it('says to use commas when given two commands', () => {
    expect(() => parseArgs(['smoke', 'checkout'])).toThrow(UsageError)
    expect(() => parseArgs(['smoke', 'checkout'])).toThrow('gta smoke,checkout')
  })

  it('refuses single-dash options it does not know', () => {
    expect(() => parseArgs(['all', '-x'])).toThrow('Unknown option -x')
  })
})
