import { describe, expect, it } from 'vitest'
import { joinPath } from './externalEditor.js'

describe('joinPath', () => {
  it('puts a file beside a folder with the folder’s own separator', () => {
    expect(joinPath('/w/shop', 'project.yml')).toBe('/w/shop/project.yml')
    expect(joinPath('/w/shop/', 'rules.yml')).toBe('/w/shop/rules.yml')
    expect(joinPath('C:\\w\\shop', 'project.yml')).toBe('C:\\w\\shop\\project.yml')
    expect(joinPath('C:\\w\\shop\\\\', 'project.yml')).toBe('C:\\w\\shop\\project.yml')
    // A Windows path written with / keeps /.
    expect(joinPath('C:/w/shop', 'project.yml')).toBe('C:/w/shop/project.yml')
  })
})
