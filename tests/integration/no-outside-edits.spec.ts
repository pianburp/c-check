import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-outside-edits'
const repos: Repo[] = []
const outside = mkdtempSync(join(tmpdir(), 'c-check-outside-'))
afterAll(() => {
  repos.forEach(r => r.cleanup())
  rmSync(outside, { recursive: true, force: true })
})

async function session() {
  const r = await makeRepo({ 'src/a.txt': 'a\n', 'notes.txt': 'first\n' }, { config: { rules: { 'tests-pass-before-done': { mode: 'off' } } } })
  repos.push(r)
  await r.start()
  return r
}

const flipDrive = (p: string) => p.replace(/^([A-Za-z]):/, (_, d: string) => (d === d.toUpperCase() ? d.toLowerCase() : d.toUpperCase()) + ':')

describe.concurrent('no-outside-edits: bad cases block', () => {
  const bad: Array<[string, (r: Repo) => [string, Record<string, unknown>]]> = [
    ['Write to an absolute path outside', () => ['Write', { file_path: join(outside, 'x.txt'), content: 'x' }]],
    ['Write escaping with ..', r => ['Write', { file_path: `${r.root}/../escape-${Date.now()}.txt`, content: 'x' }]],
    ['Write escaping with a relative ../', () => ['Write', { file_path: `../rel-escape-${Date.now()}.txt`, content: 'x' }]],
    ['Write escaping deep with src/../../', r => ['Write', { file_path: `${r.root}/src/../../deep-${Date.now()}.txt`, content: 'x' }]],
    ['Edit a file outside', () => ['Edit', { file_path: join(outside, 'e.txt'), old_string: 'a', new_string: 'b', replace_all: false }]],
    ['MultiEdit a file outside', () => ['MultiEdit', { file_path: join(outside, 'm.txt'), edits: [{ old_string: 'a', new_string: 'b' }] }]],
    ['NotebookEdit outside', () => ['NotebookEdit', { notebook_path: join(outside, 'n.ipynb'), new_source: 'x' }]],
    ['Write into a new folder outside', () => ['Write', { file_path: join(outside, 'new', 'deep', 'x.txt'), content: 'x' }]],
    ['Write with backslashes outside', () => ['Write', { file_path: join(outside, 'bs.txt').replace(/\//g, '\\'), content: 'x' }]],
    ['Write through a link inside the project that points outside', r => {
      symlinkSync(outside, join(r.root, 'link-out'), 'junction')
      return ['Write', { file_path: join(r.root, 'link-out', 'via-link.txt'), content: 'x' }]
    }],
    ['Write to the home folder', () => ['Write', { file_path: join(tmpdir(), '..', `home-${Date.now()}.txt`), content: 'x' }]],
  ]
  for (const [name, make] of bad) {
    test(name, async () => {
      const r = await session()
      const [tool, args] = make(r)
      const res = await r.tool(tool, args)
      expect(res.deny).toBe(`[c-check: ${RULE}] This file is outside the project. Edit files inside ${r.root} only.`)
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'before', tool, verdict: 'block', applied: 'block' })
    })
  }
})

describe.concurrent('no-outside-edits: good cases allow', () => {
  const good: Array<[string, (r: Repo) => [string, Record<string, unknown>]]> = [
    ['Write inside with an absolute path', r => ['Write', { file_path: join(r.root, 'b.txt'), content: 'b' }]],
    ['Write inside with a relative path', () => ['Write', { file_path: 'rel.txt', content: 'r' }]],
    ['Write into a new nested folder', r => ['Write', { file_path: join(r.root, 'new', 'deep', 'c.txt'), content: 'c' }]],
    ['Write with ./', r => ['Write', { file_path: `${r.root}/./dot.txt`, content: 'd' }]],
    ['.. that stays inside', r => ['Write', { file_path: `${r.root}/src/../stays.txt`, content: 's' }]],
    ['drive letter in other case', r => ['Write', { file_path: flipDrive(join(r.root, 'case.txt')), content: 'c' }]],
    ['Edit inside', r => ['Edit', { file_path: join(r.root, 'notes.txt'), old_string: 'first', new_string: 'second', replace_all: false }]],
    ['Read outside is not an edit', () => ['Read', { file_path: join(outside, 'x.txt') }]],
    ['Bash is not a file tool', () => ['Bash', { command: 'echo hi > /tmp/x' }]],
    ['link inside pointing inside', r => {
      mkdirSync(join(r.root, 'real'), { recursive: true })
      symlinkSync(join(r.root, 'real'), join(r.root, 'link-in'), 'junction')
      return ['Write', { file_path: join(r.root, 'link-in', 'ok.txt'), content: 'x' }]
    }],
    ['file name with spaces', r => ['Write', { file_path: join(r.root, 'my notes.txt'), content: 'x' }]],
  ]
  for (const [name, make] of good) {
    test(name, async () => {
      const r = await session()
      const [tool, args] = make(r)
      const res = await r.tool(tool, args)
      expect(res.deny).toBeUndefined()
      const line = r.lines(RULE).at(-1)
      expect(line).toMatchObject({ point: 'before', tool, verdict: 'allow', applied: 'allow' })
    })
  }
})
