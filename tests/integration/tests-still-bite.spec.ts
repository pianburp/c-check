import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'tests-still-bite'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

// Plain node "tests": a test file throws when it fails, run-tests.js loads every *.test.js. Fast and no framework.
const RUNNER = `const fs = require('fs')
if (__dirname.includes('c-check-r8') && fs.existsSync('hang')) setTimeout(() => {}, 4000)
else for (const f of fs.readdirSync('tests', { recursive: true })) if (f.endsWith('.test.js')) require('./tests/' + f)
`
const T1 = `const assert = require('assert')
const { add } = require(process.cwd() + '/src/math')
assert.strictEqual(add(1, 1), 2)
assert.strictEqual(add(2, 3), 5)
`
const T2 = `const assert = require('assert')
const { add } = require(process.cwd() + '/src/math')
assert.strictEqual(add(2, 2), 4)
`
const GOOD_SRC = 'exports.add = (a, b) => a + b\n'
// Wrong only for a < 2, so the second test file still passes.
const BAD_SRC = 'exports.add = (a, b) => a + b + (a < 2 ? 1 : 0)\n'
const BASE: Record<string, string> = {
  'run-tests.js': RUNNER,
  'src/math.js': GOOD_SRC,
  'tests/math.test.js': T1,
  'tests/more.test.js': T2,
  'package.json': JSON.stringify({ name: 'x', scripts: { test: 'node run-tests.js' } }),
}
const NEEDS_ENV = { ...BASE, '.gitignore': '.env.test\n', '.env.test': 'X=1\n', 'run-tests.js': `if (!require('fs').existsSync('.env.test')) process.exit(1)\n${RUNNER}` }
const config = (r1: Record<string, unknown> = {}) => ({ rules: { 'tests-pass-before-done': { mode: 'enforce', command: 'node run-tests.js', ...r1 }, [RULE]: { mode: 'enforce' }, 'no-test-weakening': { mode: 'off' }, 'no-test-bloat': { mode: 'off' } } })

async function session(change: (r: Repo) => Promise<void> | void, opts: { base?: Record<string, string>; cfg?: unknown; prompt?: string } = {}) {
  const r = await makeRepo(opts.base ?? BASE, { config: opts.cfg ?? config() })
  repos.push(r)
  await r.start()
  if (opts.prompt !== undefined) await r.prompt(opts.prompt)
  await change(r)
  return r
}
const BENT = T1.replace('(1, 1), 2)', '(1, 1), 3)')
// Source is broken, then the tests are bent so they pass again.
const cheat = (files: Record<string, string>, rm: string[] = []) => (r: Repo) => {
  r.write('src/math.js', BAD_SRC)
  for (const f of rm) r.rm(f)
  for (const [f, t] of Object.entries(files)) r.write(f, t)
}

describe.concurrent('tests-still-bite: bad cases send Claude back', () => {
  const bad: Array<[string, (r: Repo) => Promise<void> | void]> = [
    ['expected value changed', cheat({ 'tests/math.test.js': BENT })],
    ['assert weakened', cheat({ 'tests/math.test.js': T1.replace('assert.strictEqual(add(1, 1), 2)', 'assert.ok(add(1, 1) !== undefined)').replace('assert.strictEqual(add(2, 3), 5)', 'assert.ok(true)') })],
    ['assert commented out', cheat({ 'tests/math.test.js': T1.replace(/assert\.strictEqual/g, '// assert.strictEqual') })],
    ['assert lines deleted', cheat({ 'tests/math.test.js': T1.split('\n').slice(0, 2).join('\n') + '\n' })],
    ['test input changed', cheat({ 'tests/math.test.js': T1.replace('add(1, 1), 2)', 'add(0, 1), 2)').replace('add(2, 3), 5)', 'add(1, 3), 5)') })],
    ['assert wrapped in try/catch', cheat({ 'tests/math.test.js': T1.replace('assert.strictEqual(add(1, 1), 2)', 'try { assert.strictEqual(add(1, 1), 2) } catch {}').replace('assert.strictEqual(add(2, 3), 5)', 'try { assert.strictEqual(add(2, 3), 5) } catch {}') })],
    ['deleted test file plus weakened one', cheat({ 'tests/math.test.js': T1.replace(/assert\.strictEqual/g, '// assert.strictEqual') }, ['tests/more.test.js'])],
    ['test file emptied', cheat({ 'tests/math.test.js': '' })],
    ['moved test file with changed expectations', cheat({ 'tests/unit/math.test.js': BENT }, ['tests/math.test.js'])],
    ['both test files bent', cheat({ 'tests/math.test.js': BENT, 'tests/more.test.js': `// ok
${T2}` })],
    ['new test file added next to bent old one', cheat({ 'tests/math.test.js': BENT, 'tests/new.test.js': T2 })],
    ['edited through the Edit tool', async r => {
      r.write('src/math.js', BAD_SRC)
      await r.tool('Edit', { file_path: `${r.root}/tests/math.test.js`, old_string: '(1, 1), 2)', new_string: '(1, 1), 3)', replace_all: false })
    }],
  ]
  for (const [name, change] of bad) {
    test(name, async () => {
      const r = await session(change)
      const res = await r.stop()
      expect(res.block).toContain('The original tests fail on your new code. You changed the tests to match the code. Fix the code.')
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'end', verdict: 'send_back', applied: 'send_back' })
    })
  }
})

describe.concurrent('tests-still-bite: good cases pass', () => {
  const good: Array<[string, (r: Repo) => Promise<void> | void, { cfg?: unknown; prompt?: string; base?: Record<string, string> }?, string?]> = [
    ['no changes', () => {}],
    ['source fix only', r => r.write('src/math.js', 'exports.add = (a, b) => b + a\n')],
    ['new test added', r => r.write('tests/new.test.js', T2.replace('(2, 2), 4)', '(3, 3), 6)'))],
    ['test file renamed', r => {
      r.rm('tests/math.test.js')
      r.write('tests/unit/math.test.js', T1)
    }],
    ['test made stricter', r => r.write('tests/math.test.js', `${T1}assert.strictEqual(add(0, 0), 0)\n`)],
    ['comment added to test', r => r.write('tests/math.test.js', `// adds numbers\n${T1}`)],
    ['test file deleted and recreated identical', r => {
      r.rm('tests/more.test.js')
      r.write('tests/more.test.js', T2)
    }],
    ['non-test file only', r => r.write('README.md', '# x\n')],
    // The tests need a git-ignored file, so they fail in the copy whatever the change.
    ['copy lacks an ignored file the tests need', r => r.write('tests/math.test.js', `// adds numbers\n${T1}`), { base: NEEDS_ENV }, 'copy broken'],
    ['R1 off => R8 skipped', cheat({ 'tests/math.test.js': BENT }), { cfg: { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce' } } } }, 'did not pass'],
  ]
  for (const [name, change, opts, skipped] of good) {
    test(name, async () => {
      const r = await session(change, opts)
      const res = await r.stop()
      expect(res.block).toBeUndefined()
      const last = r.lines(RULE).at(-1)
      expect(last).toMatchObject({ verdict: 'allow', applied: 'allow' })
      if (skipped !== undefined) expect(JSON.stringify(last)).toContain(skipped)
    })
  }

  test('R1 failing => R8 skipped', async () => {
    const r = await session(r => {
      r.write('src/math.js', BAD_SRC)
      r.write('tests/new.test.js', T2)
    })
    const res = await r.stop()
    expect(res.block).toContain('failed (exit code 1)')
    expect(res.block).not.toContain('The original tests fail')
    expect(r.lines(RULE).at(-1)).toMatchObject({ verdict: 'allow' })
  })

  test('prompt-requested test change warns instead of sending back', async () => {
    const r = await session(cheat({ 'tests/math.test.js': BENT }), { prompt: 'Please update the tests, the add semantics changed' })
    const res = await r.stop()
    expect(res.block).toBeUndefined()
    const last = r.lines(RULE).at(-1)
    expect(last).toMatchObject({ verdict: 'warn', applied: 'warn' })
    expect(JSON.stringify(last)).toContain('"downgraded":"prompt"')
    expect(JSON.stringify(r.logs())).not.toContain('add semantics') // prompt text is never logged
  })

  test('unrelated prompt does not downgrade', async () => {
    const r = await session(cheat({ 'tests/math.test.js': BENT }), { prompt: 'Make add faster' })
    const res = await r.stop()
    expect(res.block).toContain('The original tests fail')
  })
})

// Sequential: these look for leftovers in the shared OS temp dir.
describe('tests-still-bite: the temp copy is always removed', () => {
  const leftovers = () => readdirSync(tmpdir()).filter(f => f.startsWith('c-check-r8-'))
  const worktrees = (root: string) => execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).split('\n').filter(l => l.startsWith('worktree ')).length

  test('after a failing test command', async () => {
    const r = await session(cheat({ 'tests/math.test.js': BENT }))
    expect((await r.stop()).block).toContain('The original tests fail')
    expect(leftovers()).toEqual([])
    expect(worktrees(r.root)).toBe(1)
  })

  test('after a timeout, and the check only warns', async () => {
    const r = await session(cheat({ 'tests/math.test.js': BENT }), { base: { ...BASE, hang: '' }, cfg: config({ timeoutSec: 2 }) })
    const res = await r.stop()
    expect(res.block).toBeUndefined()
    expect(r.lines(RULE).at(-1)).toMatchObject({ verdict: 'warn', applied: 'warn' })
    expect(JSON.stringify(r.lines(RULE).at(-1))).toContain('timedOut')
    expect(leftovers()).toEqual([])
    expect(worktrees(r.root)).toBe(1)
  }, 30_000)

  test('node_modules is linked in the copy and never deleted from the project', async () => {
    const base = { ...BASE, 'node_modules/dep/index.js': 'exports.v = 1\n', '.gitignore': 'node_modules\n', 'run-tests.js': `${RUNNER}require('dep')\n` }
    const r = await session(r => r.write('tests/math.test.js', `// ok\n${T1}`), { base })
    const res = await r.stop()
    expect(res.block).toBeUndefined()
    expect(JSON.stringify(r.lines(RULE).at(-1))).toContain('exitCode') // ran, and passed: without the link the copy could not load dep
    expect(existsSync(join(r.root, 'node_modules/dep/index.js'))).toBe(true)
    expect(leftovers()).toEqual([])
  })
})
