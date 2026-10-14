// Path edge cases that are hard to set up for real (§12.2): Windows spellings, symlink loops.
import { describe, expect, test } from 'vitest'
import { isInside, relativeTo, resolvePath } from '../../src/engine/paths'
import type { Ports } from '../../src/engine/types'
import { landingPath } from '../../src/rules/no-outside-edits'

describe('paths', () => {
  test('Windows paths compare without case and with either slash', () => {
    expect(isInside(resolvePath('c:\\Repo', 'Src\\A.ts'), resolvePath('C:/repo', '.'))).toBe(true)
    expect(isInside(resolvePath('C:/repo', '..\\other\\a.ts'), resolvePath('C:/repo', '.'))).toBe(false)
  })

  test('a sibling folder that shares a prefix is outside', () => {
    expect(isInside('/work/repo-evil/a', '/work/repo')).toBe(false)
    expect(isInside('C:/work/RepoX/a', 'C:/work/repo')).toBe(false)
  })

  test('POSIX paths are case-sensitive', () => {
    expect(isInside('/Work/repo/a', '/work/repo')).toBe(false)
  })

  test('.. cannot climb above the drive root', () => {
    expect(resolvePath('C:/', '../../x')).toBe('C:/x')
    expect(resolvePath('/', '../../x')).toBe('/x')
  })

  test('relativeTo gives POSIX paths or null', () => {
    expect(relativeTo('C:\\repo', 'C:\\repo\\src\\a.ts')).toBe('src/a.ts')
    expect(relativeTo('/repo', '/elsewhere/a')).toBeNull()
  })

  test('a symlink loop resolves to nothing and falls back to the parent', async () => {
    // realPath answers undefined for the looping link, as $.fs.stat does for a path that leads nowhere.
    const ports = { realPath: async (p: string) => (p.includes('loop') ? undefined : p) } as unknown as Ports
    expect(await landingPath(ports, '/repo/loop/a.txt')).toBe('/repo/loop/a.txt')
  })

  test('a link deep in the path redirects everything under it', async () => {
    const ports = { realPath: async (p: string) => (p === '/repo/link' ? '/etc' : p.startsWith('/repo/link/') ? undefined : p) } as unknown as Ports
    expect(await landingPath(ports, '/repo/link/new/file.txt')).toBe('/etc/new/file.txt')
  })
})
