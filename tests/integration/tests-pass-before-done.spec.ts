import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, testScript, type Repo } from './harness'

const RULE = 'tests-pass-before-done'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

const pkg = (test: string) => JSON.stringify({ name: 'x', scripts: { test } })
const only = (command: string, extra: Record<string, unknown> = {}) => ({ rules: { [RULE]: { mode: 'enforce', command, ...extra }, 'no-test-weakening': { mode: 'off' } } })

async function session(files: Record<string, string>, config: unknown, change = true) {
  const repo = await makeRepo(files, { config })
  repos.push(repo)
  await repo.start()
  if (change) await repo.tool('Write', { file_path: `${repo.root}/src/app.js`, content: 'export const a = 1\n' })
  return repo
}

describe.concurrent('tests-pass-before-done: bad cases send Claude back', () => {
  const fails: Array<[string, Record<string, string>, unknown]> = [
    ['configured command exits 1', {}, only(testScript(false))],
    ['configured command exits 2', {}, only('node -e "process.exit(2)"')],
    ['command prints a failure on stderr', {}, only('node -e "console.error(\'FAIL x\');process.exit(1)"')],
    ['command prints many lines', {}, only('node -e "for(let i=0;i<200;i++)console.log(\'line \'+i);process.exit(1)"')],
    ['npm test detected from package.json', { 'package.json': pkg(testScript(false)) }, { rules: { 'no-test-weakening': { mode: 'off' } } }],
    ['command does not exist', {}, only('definitely-not-a-command-xyz')],
    ['command throws in node', {}, only('node -e "throw new Error(\'boom\')"')],
    ['config command beats package.json', { 'package.json': pkg(testScript(true)) }, only(testScript(false))],
    ['command times out', {}, only('node -e "setTimeout(()=>{},20000)"', { timeoutSec: 1 })],
    ['failing script with spaces in args', {}, only('node -e "if (1 + 1 === 2) process.exit(3)"')],
  ]
  for (const [name, files, config] of fails) {
    test(name, async () => {
      const r = await session(files, config)
      const res = await r.stop()
      expect(res.block).toMatch(/\[c-check: tests-pass-before-done\]/)
      expect(res.block).toMatch(name === 'command times out' ? /did not finish within 1 s/ : /Fix the failing tests, then finish\./)
      const line = r.lines(RULE).at(-1)
      expect(line).toMatchObject({ point: 'end', rule: RULE, mode: 'enforce', verdict: 'send_back', applied: 'send_back' })
    })
  }

  test('output is trimmed to the last 50 lines', async () => {
    const r = await session({}, only('node -e "for(let i=0;i<200;i++)console.log(\'line \'+i);process.exit(1)"'))
    const res = await r.stop()
    expect(res.block).toContain('line 199')
    expect(res.block).not.toContain('line 140\n')
  })
})

describe.concurrent('tests-pass-before-done: good cases allow', () => {
  const passes: Array<[string, Record<string, string>, unknown, boolean?]> = [
    ['configured command exits 0', {}, only(testScript(true))],
    ['npm test passes', { 'package.json': pkg(testScript(true)) }, { rules: { 'no-test-weakening': { mode: 'off' } } }],
    ['observe mode turns a failure into allow', {}, { rules: { [RULE]: { mode: 'observe', command: testScript(false) } } }],
    ['off mode does not run', {}, { rules: { [RULE]: { mode: 'off', command: testScript(false) } } }],
    ['no changes in the session: tests are not rerun', {}, only(testScript(false)), false],
    ['command with output passes', {}, only('node -e "console.log(\'ok 1\')"')],
    ['config command beats failing package.json', { 'package.json': pkg(testScript(false)) }, only(testScript(true))],
    ['command writes stderr but exits 0', {}, only('node -e "console.error(\'warn\')"')],
    ['quick command under timeout', {}, only(testScript(true), { timeoutSec: 30 })],
    ['passing script with quotes', {}, only('node -e "if (\'a\' === \'a\') process.exit(0)"')],
  ]
  for (const [name, files, config, change] of passes) {
    test(name, async () => {
      const r = await session(files, config, change ?? true)
      const res = await r.stop()
      expect(res.block).toBeUndefined()
      if (name.startsWith('off')) expect(r.lines(RULE)).toHaveLength(0)
      else expect(r.lines(RULE).at(-1)).toMatchObject({ applied: 'allow' })
    })
  }

  test('no test command found warns', async () => {
    const r = await session({}, { rules: { 'no-test-weakening': { mode: 'off' } } })
    const res = await r.stop()
    expect(res.block).toBeUndefined()
    expect((await r.turnComplete()).text).toContain('No test command found.')
    expect((await r.prompt('next task')).context.join(' ')).toContain('No test command found.')
  })

  test('a green run is not repeated while nothing changes', async () => {
    const r = await session({}, only(testScript(true)))
    await r.stop()
    await r.stop()
    expect(r.lines(RULE).at(-1)?.details).toMatchObject({ skipped: 'no changes since last pass' })
  })
})

describe.concurrent('loop safety', () => {
  test('the 4th send-back from one rule becomes warn and gave_up', async () => {
    const r = await session({}, only(testScript(false)))
    for (let i = 0; i < 3; i++) expect((await r.stop({ stop_hook_active: i > 0 })).block).toBeDefined()
    const fourth = await r.stop({ stop_hook_active: true })
    expect(fourth.block).toBeUndefined()
    expect((await r.turnComplete()).text).toContain('c-check could not get this check to pass after 3 tries. A human should look at it.')
    expect(r.logs().some(l => l.event === 'gave_up' && l.rule === RULE)).toBe(true)
  })

  test('a pass resets the count', async () => {
    const r = await session({}, only('node -e "process.exit(require(\'fs\').existsSync(\'ok\')?0:1)"'))
    await r.stop()
    await r.stop()
    r.write('ok', '')
    expect((await r.stop()).block).toBeUndefined()
    r.rm('ok')
    r.write('src/b.js', 'x')
    for (let i = 0; i < 3; i++) expect((await r.stop()).block).toBeDefined()
  })
})
