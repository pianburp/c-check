import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))
const CLI = join(process.cwd(), 'src', 'cli', 'c-check.ts')

test('c-check report counts per rule from a real session log', async () => {
  const r = await makeRepo({ 'package.json': JSON.stringify({ scripts: { test: 'node -e "process.exit(1)"' } }) }, { config: { rules: { 'no-risky-commands': { mode: 'observe' } } } })
  repos.push(r)
  await r.start()
  await r.tool('Bash', { command: 'git reset --hard' })
  await r.tool('Write', { file_path: `${r.root}/../out-${Date.now()}.txt`, content: 'x' })
  await r.tool('Write', { file_path: `${r.root}/a.js`, content: 'x' })
  for (let i = 0; i < 4; i++) await r.stop()

  const out = execFileSync(process.execPath, [CLI, 'report', r.root], { encoding: 'utf8' })
  const row = (rule: string) => out.split('\n').find(l => l.startsWith(rule))?.trim().split(/\s+/)
  // rule, mode, runs, warns, blocks, send-backs, gave-ups, errors, labeled right, labeled wrong
  expect(row('no-risky-commands')).toEqual(['no-risky-commands', 'observe', '3', '0', '1', '0', '0', '0', '0', '0'])
  expect(row('no-outside-edits')).toEqual(['no-outside-edits', 'enforce', '3', '0', '1', '0', '0', '0', '0', '0'])
  expect(row('tests-pass-before-done')).toEqual(['tests-pass-before-done', 'enforce', '4', '0', '0', '4', '1', '0', '0', '0'])
})

test('c-check report with no logs says so', async () => {
  const r = await makeRepo({}, { git: false })
  repos.push(r)
  expect(execFileSync(process.execPath, [CLI, 'report', r.root], { encoding: 'utf8' })).toContain('No c-check logs in')
})
