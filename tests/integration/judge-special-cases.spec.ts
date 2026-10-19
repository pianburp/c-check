import { copyFileSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { makeRepo, testScript, type Repo } from './harness'

const RULE = 'judge-special-cases'
const repos: Repo[] = []
let shimDir = ''
const saved = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS }

// A fake `claude`: a copy of node named claude, which a preloaded script turns into the fake. It acts only when run as `claude`,
// so the test commands that also run node are untouched. Its answer comes from .c-check/judge-mode in the cwd (the repo).
beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), 'c-check-fake-claude-'))
  const bin = join(shimDir, process.platform === 'win32' ? 'claude.exe' : 'claude')
  if (process.platform === 'win32') copyFileSync(process.execPath, bin)
  else symlinkSync(process.execPath, bin)
  writeFileSync(
    join(shimDir, 'fake.cjs'),
    `const path = require('path'), fs = require('fs')
if (/^claude/i.test(path.basename(process.execPath))) {
  const mode = fs.readFileSync('.c-check/judge-mode', 'utf8').trim()
  fs.writeFileSync('.c-check/judge-args', JSON.stringify({ argv: process.execArgv, child: process.env.C_CHECK_CHILD }))
  if (mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000)
  else {
    const ok = process.env.C_CHECK_CHILD === '1'
    if (mode === 'clean' && ok) console.log('{"verdict":"clean"}')
    else if (mode === 'suspect' && ok) console.log('{"verdict":"suspect","file":"src/math.js","line":12}')
    else if (mode === 'block') console.log('{"verdict":"block"}')
    else if (mode === 'two') console.log('{"verdict":"clean"}\\n{"verdict":"clean"}')
    else console.log('not json, SECRET-MODEL-TEXT')
    process.exit(mode === 'fail' ? 3 : 0)
  }
}
`,
  )
  process.env.PATH = `${shimDir}${delimiter}${saved.PATH}`
  process.env.NODE_OPTIONS = `--require "${join(shimDir, 'fake.cjs').replace(/\\/g, '/')}"`
})
afterAll(() => {
  process.env.PATH = saved.PATH
  if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = saved.NODE_OPTIONS
  repos.forEach(r => r.cleanup())
  rmSync(shimDir, { recursive: true, force: true })
})

const SRC = 'export const add = (a, b) => (a === 2 && b === 2 ? 4 : a + b)\n'
type Opts = { mode?: string; r1?: boolean; judge?: Record<string, unknown>; files?: Record<string, string> }

/** A session where Claude wrote `files` (default: one source file) and then tries to finish. */
async function session({ mode = 'clean', r1 = true, judge = {}, files = { 'src/math.js': SRC } }: Opts = {}) {
  const config = {
    rules: {
      'tests-pass-before-done': { mode: 'enforce', command: testScript(r1), timeoutSec: 30 },
      'no-test-weakening': { mode: 'off' },
      [RULE]: { mode: 'enforce', ...judge },
    },
  }
  const r = await makeRepo({}, { config })
  repos.push(r)
  r.write('.c-check/judge-mode', mode)
  await r.start()
  for (const [path, text] of Object.entries(files)) await r.tool('Write', { file_path: `${r.root}/${path}`, content: text })
  const res = await r.stop()
  const line = r.lines(RULE).at(-1)
  return { r, res, line, ran: (() => { try { return JSON.parse(r.read('.c-check/judge-args')) } catch { return undefined } })() }
}

describe.concurrent('judge-special-cases: model answers', () => {
  test('clean: allow, silent', async () => {
    const { r, res, line, ran } = await session()
    expect(res.block).toBeUndefined()
    expect(line).toMatchObject({ rule: RULE, verdict: 'allow', applied: 'allow', details: { verdict: 'clean' } })
    expect(ran.child).toBe('1')
    expect(ran.argv).toContain('-p')
    expect(ran.argv.join(' ')).toContain('a === 2 && b === 2') // the diff reaches the prompt
    expect(JSON.stringify(r.logs())).not.toContain('a === 2') // and never the log
  })

  test('suspect: warn with file:line, never a block', async () => {
    const { r, res, line } = await session({ mode: 'suspect' })
    expect(res.block).toBeUndefined()
    expect(line).toMatchObject({ verdict: 'warn', applied: 'warn', details: { verdict: 'suspect', file: 'src/math.js', line: 12 } })
    const ctx = JSON.stringify(await r.prompt('next'))
    expect(ctx).toContain('This change may return fixed answers for the test inputs at src/math.js:12. Check that the real logic is fixed.')
  })

  const bad: Array<[string, string]> = [
    ['bad JSON', 'bad'],
    ['two lines', 'two'],
    ['unknown verdict (never block)', 'block'],
    ['non-zero exit', 'fail'],
  ]
  for (const [name, mode] of bad) {
    test(`${name}: allow and log an error`, async () => {
      const { r, res, line } = await session({ mode })
      expect(res.block).toBeUndefined()
      expect(line).toMatchObject({ verdict: 'allow', applied: 'allow', event: 'error' })
      expect(JSON.stringify(r.logs())).not.toContain('SECRET-MODEL-TEXT')
    })
  }

  test('timeout: allow and log an error', async () => {
    const { res, line } = await session({ mode: 'hang', judge: { timeoutSec: 1 } })
    expect(res.block).toBeUndefined()
    expect(line).toMatchObject({ verdict: 'allow', applied: 'allow', event: 'error', details: { error: expect.stringContaining('timed out') } })
  })
})

describe.concurrent('judge-special-cases: when it does not run', () => {
  test('tests fail: skipped', async () => {
    const { res, line, ran } = await session({ r1: false })
    expect(res.block).toMatch(/tests-pass-before-done/)
    expect(line).toMatchObject({ details: { skipped: 'tests did not pass' } })
    expect(ran).toBeUndefined()
  })

  test('only test files changed: skipped', async () => {
    const { line, ran } = await session({ files: { 'tests/math.spec.js': 'test("a", () => {})\n' } })
    expect(line).toMatchObject({ details: { skipped: 'no source changes' } })
    expect(ran).toBeUndefined()
  })

  test('diff too big: skipped', async () => {
    const { line, ran } = await session({ judge: { maxDiffLines: 1 }, files: { 'src/a.js': 'a\nb\nc\n' } })
    expect(line).toMatchObject({ details: { skipped: 'diff too big' } })
    expect(ran).toBeUndefined()
  })

  test('mode off: not run, not logged', async () => {
    const { line, ran } = await session({ judge: { mode: 'off' } })
    expect(line).toBeUndefined()
    expect(ran).toBeUndefined()
  })
})

// Not concurrent: it changes PATH for the whole process while it runs.
describe('judge-special-cases: missing binary', () => {
  test('allow and log an error', async () => {
    // Drop every PATH folder that holds a real claude: this test must never reach the model.
    process.env.PATH = (saved.PATH ?? '').split(delimiter).filter(d => !['claude', 'claude.exe', 'claude.cmd'].some(f => existsSync(join(d, f)))).join(delimiter)
    try {
      const { res, line } = await session()
      expect(res.block).toBeUndefined()
      expect(line).toMatchObject({ verdict: 'allow', applied: 'allow', event: 'error', details: { error: 'judge could not start' } })
    } finally {
      process.env.PATH = `${shimDir}${delimiter}${saved.PATH}`
    }
  })
})
