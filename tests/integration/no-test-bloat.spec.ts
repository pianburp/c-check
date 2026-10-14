import { afterAll, describe, expect, test } from 'vitest'
import { makeRepo, type Repo } from './harness'

const RULE = 'no-test-bloat'
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

const FILES = { 'src/math.js': 'export const add = (a, b) => a + b\n', 'tests/integration/math.test.js': "it('adds', () => {})\n" }
const cases = (n: number, name = 'case') => Array.from({ length: n }, (_, i) => `it('${name} ${i}', () => { expect(${i}).toBe(${i}) })`).join('\n') + '\n'
const sourceLines = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'

async function session(prompt: string | null, extra: Record<string, unknown> = {}) {
  const r = await makeRepo(FILES, { config: { rules: { 'tests-pass-before-done': { mode: 'off' }, 'no-test-weakening': { mode: 'off' }, [RULE]: { mode: 'enforce', ...extra } } } })
  repos.push(r)
  await r.start()
  if (prompt !== null) await r.prompt(prompt)
  return r
}

describe.concurrent('no-test-bloat: bad cases warn', () => {
  const bad: Array<[string, string | null, (r: Repo) => void, RegExp, Record<string, unknown>?]> = [
    ['new unit test file nobody asked for', 'Fix the add function', r => r.write('tests/unit/add.test.js', cases(1)), /new unit test files the user did not ask for: tests\/unit\/add\.test\.js/],
    ['two new unit test files', 'Refactor math', r => {
      r.write('tests/unit/a.test.js', cases(1))
      r.write('tests/unit/b.test.js', cases(1))
    }, /tests\/unit\/a\.test\.js, tests\/unit\/b\.test\.js/],
    ['custom unit folder from config', 'Clean up', r => r.write('spec/unit/x.spec.js', cases(1)), /spec\/unit\/x\.spec\.js/, { unitTestDir: 'spec/unit' }],
    ['too many new test cases', null, r => {
      r.write('src/math.js', sourceLines(40))
      r.write('tests/integration/more.test.js', cases(6))
    }, /6 new test cases/],
    ['too many test lines for the source change', null, r => {
      r.write('src/math.js', 'export const add = (a, b) => b + a\n')
      r.write('tests/integration/big.test.js', cases(3) + '// pad\n'.repeat(20))
    }, /test lines added for 2 source lines changed/],
    ['tests with no source change', null, r => r.write('tests/integration/only.test.js', '// x\n'.repeat(12)), /12 test lines added for 0 source lines changed/],
    ['lower case limit from config', null, r => {
      r.write('src/math.js', sourceLines(40))
      r.write('tests/integration/three.test.js', cases(3))
    }, /3 new test cases/, { maxNewTestCases: 2 }],
    ['lower ratio from config', null, r => {
      r.write('src/math.js', sourceLines(10))
      r.write('tests/integration/r.test.js', '// x\n'.repeat(15))
    }, /15 test lines added/, { maxTestToSourceRatio: 1 }],
    ['a test that mocks the module it tests (vitest)', null, r => {
      r.write('src/math.js', sourceLines(20))
      r.write('tests/integration/math2.test.js', "vi.mock('../../src/math2.js')\n")
      r.write('src/math2.js', sourceLines(5))
    }, /mocks the module it tests/],
    ['a test that mocks the module it tests (jest)', null, r => {
      r.write('src/user.js', sourceLines(20))
      r.write('tests/integration/user.test.js', "jest.mock('../../src/user')\n")
    }, /tests\/integration\/user\.test\.js mocks the module it tests/],
  ]
  for (const [name, prompt, change, why, extra] of bad) {
    test(name, async () => {
      const r = await session(prompt, extra)
      change(r)
      expect((await r.stop()).block).toBeUndefined()
      const text = (await r.turnComplete()).text as string
      expect(text).toMatch(why)
      expect(text).toContain('Keep only tests for edge cases an integration test cannot cover.')
      expect(r.lines(RULE).at(-1)).toMatchObject({ point: 'end', verdict: 'warn', applied: 'warn' })
    })
  }
})

describe.concurrent('no-test-bloat: good cases allow', () => {
  const good: Array<[string, string | null, (r: Repo) => void]> = [
    ['no changes', 'Fix the add function', () => {}],
    ['source change only', 'Fix the add function', r => r.write('src/math.js', 'export const add = (a, b) => b + a\n')],
    ['user asked for tests', 'Add unit tests for add', r => r.write('tests/unit/add.test.js', cases(1))],
    ['user mentioned coverage', 'Improve coverage of math', r => r.write('tests/unit/add.test.js', cases(1))],
    ['prompt unknown: unit file sign skipped', null, r => r.write('tests/unit/add.test.js', cases(1))],
    ['few tests for a big change', 'Build the feature', r => {
      r.write('src/math.js', sourceLines(50))
      r.write('tests/integration/feature.test.js', cases(3))
    }],
    ['exactly the case limit', 'Build it', r => {
      r.write('src/math.js', sourceLines(60))
      r.write('tests/integration/five.test.js', cases(5))
    }],
    ['integration test files are not unit files', 'Fix it', r => {
      r.write('src/math.js', sourceLines(10))
      r.write('tests/integration/fix.test.js', cases(1))
    }],
    ['docs do not count as source but no tests either', 'Write docs', r => r.write('README.md', '# Title\n'.repeat(30))],
    ['mocking a different module is fine', 'Fix it', r => {
      r.write('src/math.js', sourceLines(20))
      r.write('tests/integration/calc.test.js', "vi.mock('../../src/http')\n")
    }],
  ]
  for (const [name, prompt, change] of good) {
    test(name, async () => {
      const r = await session(prompt)
      change(r)
      await r.stop()
      expect((await r.turnComplete()).text).toBeUndefined()
      expect(r.lines(RULE).at(-1)).toMatchObject({ applied: 'allow' })
    })
  }

  test('never blocks, even in enforce mode', async () => {
    const r = await session('Fix it')
    r.write('tests/unit/x.test.js', cases(20))
    expect((await r.stop()).block).toBeUndefined()
  })
})
