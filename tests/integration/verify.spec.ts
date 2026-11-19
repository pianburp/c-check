import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { makeRepo, type Repo } from './harness'

const cli = fileURLToPath(new URL('../../src/cli/c-check.ts', import.meta.url))
let repo: Repo | undefined
afterEach(() => { repo?.cleanup(); repo = undefined })

function verify(root: string, base = 'HEAD') {
  const result = spawnSync(process.execPath, [cli, 'verify', '--project', root, '--base', base], { encoding: 'utf8' })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout}${result.stderr}` }
}

describe('standalone verification', () => {
  it('checks unchanged worktrees and includes untracked files without staging them', async () => {
    repo = await makeRepo({
      'package.json': JSON.stringify({ scripts: { test: 'node run.cjs' } }),
      'run.cjs': "process.exit(require('node:fs').existsSync('ready.txt') ? 0 : 1)",
    })
    expect(verify(repo.root)).toMatchObject({ code: 1, output: expect.stringContaining('tests-pass-before-done enforce finding') })
    repo.write('ready.txt', 'verified')
    repo.write('index.txt', 'staged')
    execFileSync('git', ['add', 'index.txt'], { cwd: repo.root })
    repo.write('index.txt', 'unstaged')
    expect(verify(repo.root)).toMatchObject({ code: 0, output: expect.stringContaining('tests-pass-before-done enforce passed') })
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: repo.root, encoding: 'utf8' }).trim().split(/\r?\n/)).toEqual(['AM index.txt', '?? ready.txt'])
    expect(execFileSync('git', ['show', ':index.txt'], { cwd: repo.root, encoding: 'utf8' })).toBe('staged')
  }, 30_000)

  it('uses baseline policy and catches a dirty test deletion', async () => {
    repo = await makeRepo({ 'tests/unit/example.test.js': 'test("original", () => {})\n' }, {
      config: { rules: { 'tests-pass-before-done': { command: 'node -e "process.exit(0)"' } } },
    })
    repo.rm('tests/unit/example.test.js')
    repo.write('c-check.config.json', JSON.stringify({ rules: { 'no-test-weakening': { mode: 'off' } } }))
    expect(verify(repo.root)).toMatchObject({ code: 1, output: expect.stringContaining('no-test-weakening enforce finding') })
  }, 30_000)

  it('keeps ignored files that Git tracks in the worktree snapshot', async () => {
    repo = await makeRepo({ 'tests/example.test.js': 'test("original", () => {})\n' }, {
      config: { rules: { 'tests-pass-before-done': { command: 'node -e "process.exit(0)"' } } },
    })
    repo.write('.gitignore', 'tests/\n')
    expect(verify(repo.root)).toMatchObject({ code: 0, output: expect.stringContaining('no-test-weakening enforce passed') })
    repo.write('tests/example.test.js', 'test.skip("original", () => {})\n')
    expect(verify(repo.root)).toMatchObject({ code: 1, output: expect.stringContaining('no-test-weakening enforce finding') })
  }, 30_000)

  it('reports incomplete verification for a missing test command, invalid ref, or timeout', async () => {
    repo = await makeRepo()
    expect(verify(repo.root)).toMatchObject({ code: 2, output: expect.stringContaining('tests-pass-before-done enforce incomplete') })
    expect(verify(repo.root, 'absent')).toMatchObject({ code: 2, output: expect.stringContaining('baseline does not resolve') })
    repo.write('c-check.config.json', JSON.stringify({ rules: { 'tests-pass-before-done': { command: 'node -e "setTimeout(() => {}, 20000)"', timeoutSec: 0.5 } } }))
    await repo.commit()
    expect(verify(repo.root)).toMatchObject({ code: 2, output: expect.stringContaining('tests-pass-before-done enforce incomplete') })
  }, 30_000)

  it('reports incomplete verification when baseline policy explicitly requires a live rule', async () => {
    repo = await makeRepo({}, { config: { rules: { 'no-outside-edits': { mode: 'enforce' } } } })
    expect(verify(repo.root)).toMatchObject({ code: 2, output: expect.stringContaining('required rules unavailable in standalone verification: no-outside-edits') })
  }, 30_000)
})
