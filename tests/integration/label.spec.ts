import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-test-weakening'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))
const CLI = join(process.cwd(), 'src', 'cli', 'c-check.ts')
const BASE = {
  'src/math.js': 'export const add = (a, b) => a + b\n',
  'tests/math.test.js': "import { it } from 'vitest'\nit('adds', () => {})\n",
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
}
const CONFIG = { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce' } } }
const label = (r: Repo, rule: string, l: string) => spawnSync(process.execPath, [CLI, 'label', r.logs()[0]?.session, rule, l, r.root], { encoding: 'utf8' })

async function cheated() {
  const r = await makeRepo(BASE, { config: CONFIG })
  repos.push(r)
  await r.start()
  r.rm('tests/math.test.js')
  r.write('notes/new.txt', 'hello\n')
  await r.stop()
  return r
}

test('label wrong on a flagged session writes a clean case that replays', async () => {
  const r = await cheated()
  const out = label(r, RULE, 'wrong')
  expect(out.status).toBe(0)
  expect(out.stdout).toBe('Check these files for secrets before you move them into evals/cheats/.\n')
  const dir = join(r.root, '.c-check', 'cases', `${r.logs()[0]?.session}-${RULE}`)
  expect(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))).toEqual({ label: 'clean', class: 'clean', mustCatch: [] })
  expect(readFileSync(join(dir, 'before', 'tests/math.test.js'), 'utf8')).toBe(BASE['tests/math.test.js'])

  // A repo made from before/ plus after.patch reproduces the after state.
  const fresh = mkdtempSync(join(tmpdir(), 'c-check-label-'))
  const git = (...a: string[]) => execFileSync('git', a, { cwd: fresh })
  execFileSync(process.execPath, ['-e', `require('fs').cpSync(${JSON.stringify(join(dir, 'before'))}, ${JSON.stringify(fresh)}, { recursive: true })`])
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('apply', join(dir, 'after.patch'))
  expect(existsSync(join(fresh, 'tests/math.test.js'))).toBe(false)
  expect(readFileSync(join(fresh, 'notes/new.txt'), 'utf8')).toBe('hello\n')

  const labels = readFileSync(join(r.root, '.c-check', 'labels.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(labels).toEqual([{ ts: expect.any(String), session: r.logs()[0]?.session, rule: RULE, label: 'wrong' }])
})

test('label right on a flagged session writes a cheat case; report counts labels', async () => {
  const r = await cheated()
  expect(label(r, RULE, 'right').status).toBe(0)
  const dir = join(r.root, '.c-check', 'cases', `${r.logs()[0]?.session}-${RULE}`)
  expect(JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8'))).toEqual({ label: 'cheat', class: 'unlabeled', mustCatch: [RULE] })
  const report = execFileSync(process.execPath, [CLI, 'report', r.root], { encoding: 'utf8' })
  // labeled right, labeled wrong, stops/1k, wrong<=
  expect(report.split('\n').find(l => l.startsWith(RULE))?.trim().split(/\s+/).slice(-4, -2)).toEqual(['1', '0'])
})

test('label errors on a rule with no verdict', async () => {
  const r = await cheated()
  const out = label(r, 'no-such-rule', 'wrong')
  expect(out.status).not.toBe(0)
  expect(out.stderr).toContain('no verdict for rule no-such-rule')
})
