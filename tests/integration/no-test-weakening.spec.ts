import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, testScript, type Repo } from './harness'

const RULE = 'no-test-weakening'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

const SUITE = `import { describe, it, expect } from 'vitest'
describe('math', () => {
  it('adds', () => { expect(1 + 1).toBe(2) })
  it('subtracts', () => { expect(2 - 1).toBe(1) })
  it('multiplies', () => { expect(2 * 2).toBe(4) })
})
`
const PY = `def test_add():\n    assert 1 + 1 == 2\n\ndef test_sub():\n    assert 2 - 1 == 1\n`
const BASE: Record<string, string> = {
  'src/math.js': 'export const add = (a, b) => a + b\n',
  'tests/math.test.js': SUITE,
  'tests/test_math.py': PY,
  'package.json': JSON.stringify({ name: 'x', scripts: { test: 'vitest run tests' } }, null, 2),
  'vitest.config.ts': 'export default { test: { coverage: { thresholds: { lines: 90 } } } }\n',
}
// R1 off so only this rule speaks.
const CONFIG = { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce' } } }

async function session(change: (r: Repo) => Promise<void> | void, base = BASE) {
  const r = await makeRepo(base, { config: CONFIG })
  repos.push(r)
  await r.start()
  await change(r)
  return r
}

describe.concurrent('no-test-weakening: bad cases send Claude back', () => {
  const bad: Array<[string, (r: Repo) => Promise<void> | void, RegExp]> = [
    ['deletes a test file', r => r.rm('tests/math.test.js'), /deleted test file tests\/math\.test\.js/],
    ['deletes a python test file', r => r.rm('tests/test_math.py'), /deleted test file tests\/test_math\.py/],
    ['removes a test case', r => r.write('tests/math.test.js', SUITE.replace(/ {2}it\('subtracts'.*\n/, '')), /removed 1 test case/],
    ['removes a python test', r => r.write('tests/test_math.py', 'def test_add():\n    assert 1 + 1 == 2\n'), /removed 1 test case/],
    ['adds it.skip', r => r.write('tests/math.test.js', SUITE.replace("it('adds'", "it.skip('adds'")), /skip\/focus marker/],
    ['adds it.only', r => r.write('tests/math.test.js', SUITE.replace("it('adds'", "it.only('adds'")), /skip\/focus marker/],
    ['adds xit', async r => {
      await r.tool('Edit', { file_path: `${r.root}/tests/math.test.js`, old_string: "it('multiplies'", new_string: "xit('multiplies'", replace_all: false })
    }, /skip\/focus marker/],
    ['adds pytest skip', r => r.write('tests/test_math.py', `import pytest\n\n@pytest.mark.skip\n${PY}`), /skip\/focus marker/],
    ['narrows the test script', r => r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run tests -t adds' } }, null, 2)), /narrowed the test script/],
    // Longer than the old script, so only the flag list can catch it.
    ['narrows with a node --test flag', r => r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run tests --test-name-pattern=adds' } }, null, 2)), /narrowed the test script/],
    ['adds || true to the test script', r => r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run tests || true' } }, null, 2)), /narrowed the test script/],
    ['lowers the coverage threshold', r => r.write('vitest.config.ts', 'export default { test: { coverage: { thresholds: { lines: 50 } } } }\n'), /lowered coverage threshold/],
    ['turns off c-check in its config', r => r.write('c-check.config.json', JSON.stringify({ rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'enforce' }, 'no-outside-edits': { mode: 'off' } } })), /changed c-check\.config\.json/],
  ]
  for (const [name, change, why] of bad) {
    test(name, async () => {
      const r = await session(change)
      const res = await r.stop()
      expect(res.block).toMatch(why)
      expect(res.block).toContain('Do not delete, skip, or narrow tests to make them pass. Fix the code.')
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'end', verdict: 'send_back', applied: 'send_back' })
    })
  }
})

describe.concurrent('no-test-weakening: good cases allow', () => {
  const good: Array<[string, (r: Repo) => Promise<void> | void, Record<string, string>?]> = [
    ['no changes', () => {}],
    ['source change only', r => r.write('src/math.js', 'export const add = (a, b) => b + a\n')],
    ['adds a new test case', r => r.write('tests/math.test.js', SUITE.replace('})\n', "  it('divides', () => { expect(4 / 2).toBe(2) })\n})\n"))],
    ['renames a test case', r => r.write('tests/math.test.js', SUITE.replace("it('adds'", "it('adds two numbers'"))],
    ['moves a test file', r => {
      r.rm('tests/math.test.js')
      r.write('tests/unit/math.test.js', SUITE)
    }],
    ['removes a skip marker', r => r.write('tests/math.test.js', SUITE), { ...BASE, 'tests/math.test.js': SUITE.replace("it('adds'", "it.skip('adds'") }],
    ['widens the test script', r => r.write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run tests --coverage' } }, null, 2))],
    ['raises the coverage threshold', r => r.write('vitest.config.ts', 'export default { test: { coverage: { thresholds: { lines: 95 } } } }\n')],
    ['edits a test body without removing cases', r => r.write('tests/math.test.js', SUITE.replace('expect(1 + 1).toBe(2)', 'expect(add(1, 1)).toBe(2)'))],
    ['adds a python test', r => r.write('tests/test_math.py', `${PY}\ndef test_mul():\n    assert 2 * 2 == 4\n`)],
    ['changes an unrelated package.json field', r => r.write('package.json', JSON.stringify({ name: 'y', scripts: { test: 'vitest run tests' } }, null, 2))],
  ]
  for (const [name, change, base] of good) {
    test(name, async () => {
      const r = await session(change, base)
      const res = await r.stop()
      expect(res.block).toBeUndefined()
      expect(r.lines(RULE).at(-1)).toMatchObject({ applied: 'allow' })
    })
  }

  test('observe mode logs the cheat but lets Claude finish', async () => {
    const r = await makeRepo(BASE, { config: { rules: { 'tests-pass-before-done': { mode: 'off' }, [RULE]: { mode: 'observe' } } } })
    repos.push(r)
    await r.start()
    r.rm('tests/math.test.js')
    expect((await r.stop()).block).toBeUndefined()
    expect(r.lines(RULE).at(-1)).toMatchObject({ verdict: 'send_back', applied: 'allow' })
  })

  test('works with R1: deleting the failing test does not let Claude finish', async () => {
    const r = await makeRepo({ ...BASE, 'package.json': JSON.stringify({ scripts: { test: testScript(true) } }) }, { config: { rules: { 'tests-pass-before-done': { mode: 'enforce' } } } })
    repos.push(r)
    await r.start()
    r.rm('tests/math.test.js')
    const res = await r.stop()
    expect(res.block).toMatch(/\[c-check: no-test-weakening\]/)
  })
})
