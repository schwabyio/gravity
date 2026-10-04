import { describe, expect, it } from 'vitest'
import { fileUrl, fillCommand, jetbrainsUrl, splitCommand } from './editorCommand.js'

describe('splitCommand', () => {
  it('splits on spaces and keeps quoted words whole, interpreting nothing else', () => {
    expect(splitCommand('zed {file}:{line}')).toEqual(['zed', '{file}:{line}'])
    expect(splitCommand('"/Applications/My Editor.app/bin/edit" --goto \'{file}\'')).toEqual([
      '/Applications/My Editor.app/bin/edit',
      '--goto',
      '{file}'
    ])
    expect(splitCommand('  edit   $HOME *.yml  ')).toEqual(['edit', '$HOME', '*.yml'])
    expect(splitCommand('edit ""')).toEqual(['edit', ''])
    expect(splitCommand('')).toEqual([])
  })
})

describe('fillCommand', () => {
  it('fills in the file and line, the line 1 when there is none', () => {
    expect(fillCommand(['zed', '{file}:{line}'], '/p/a.yml', 12)).toEqual(['zed', '/p/a.yml:12'])
    expect(fillCommand(['nvim', '+{line}', '{file}'], '/p/a.yml', undefined)).toEqual([
      'nvim',
      '+1',
      '/p/a.yml'
    ])
  })

  it('adds the file last when no word names it', () => {
    expect(fillCommand(['edit', '--wait'], '/p/a b.yml', 3)).toEqual([
      'edit',
      '--wait',
      '/p/a b.yml'
    ])
  })
})

describe('links', () => {
  it('opens VS Code and Cursor at a line, a path’s odd characters escaped', () => {
    expect(fileUrl('vscode', '/Users/dave/my repo/c#1.yml', 12)).toBe(
      'vscode://file/Users/dave/my%20repo/c%231.yml:12:1'
    )
    expect(fileUrl('cursor', '/p/a.yml')).toBe('cursor://file/p/a.yml')
  })

  it('writes a Windows path with its drive and forward slashes', () => {
    expect(fileUrl('vscode', 'C:\\Users\\dave\\a.yml', 3)).toBe(
      'vscode://file/C:/Users/dave/a.yml:3:1'
    )
  })

  it('opens a JetBrains IDE at a line', () => {
    expect(jetbrainsUrl('idea', '/p/a b.yml', 7)).toBe('idea://open?file=%2Fp%2Fa%20b.yml&line=7')
    expect(jetbrainsUrl('webstorm', '/p/a.yml')).toBe('webstorm://open?file=%2Fp%2Fa.yml')
  })
})
