import { baseName } from '../engine/paths'
import type { Rule } from '../engine/types'
import { isTestPath, sessionChanges, type FileDiff } from './git'
import { TEST_CASE } from './no-test-weakening'

const ID = 'no-test-bloat'
const ASKED_FOR_TESTS = /\b(?:tests?|testing|unit|spec|specs|coverage|tdd)\b/i
const NOT_SOURCE = /\.(?:md|mdx|txt|json|lock|ya?ml|toml|svg|png|jpe?g|gif|csv)$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i
// Below this many added test lines the ratio sign is noise.
const MIN_TEST_LINES = 10
const MOCK_CALL = /\b(?:vi|jest)\.mock\(\s*["'`]([^"'`]+)["'`]|\bmock\.patch\(\s*["']([^"']+)["']|@patch\(\s*["']([^"']+)["']/g

const num = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 ? v : fallback)
const subject = (testPath: string) => baseName(testPath).replace(/\.(?:test|spec)(?=\.)|^test_|_test(?=\.)/g, '').replace(/\.[^.]+$/, '')

export const noTestBloat: Rule = {
  id: ID,
  description: 'Warns when Claude adds many tests nobody asked for.',
  points: ['end'],
  kind: 'habit',
  defaultMode: 'observe',
  async check(_event, ctx) {
    const changes = await sessionChanges(ctx)
    if (changes === null) return { kind: 'allow', ruleId: ID, details: { skipped: 'no git' } }
    const { config, state } = ctx
    const unitDir = (typeof config.unitTestDir === 'string' ? config.unitTestDir : 'tests/unit').replace(/\\/g, '/').replace(/\/+$/, '')
    const ratio = num(config.maxTestToSourceRatio, 2)
    const maxCases = num(config.maxNewTestCases, 5)

    const tests = changes.files.filter(f => isTestPath(f.path))
    const source = changes.files.filter(f => !isTestPath(f.path) && !NOT_SOURCE.test(f.path))
    // A test file deleted here and added elsewhere under the same name is a move, not a new file: only its net lines count.
    const gone = new Map(tests.filter(f => f.status === 'D').map(f => [baseName(f.path), f.removed.length]))
    const isNew = (f: FileDiff) => f.status === 'A' && !gone.has(baseName(f.path))
    const testLines = tests.reduce((n, f) => n + Math.max(0, f.added.length - (f.status === 'A' ? gone.get(baseName(f.path)) ?? 0 : 0)), 0)
    const sourceLines = source.reduce((n, f) => n + f.added.length + f.removed.length, 0)
    const newCases = Math.max(0, tests.reduce((n, f) => n + f.added.filter(l => TEST_CASE.test(l)).length - f.removed.filter(l => TEST_CASE.test(l)).length, 0))

    const signs: string[] = []
    // Only judged when the prompts are known; mods give them through prompt.submit.
    if (state.prompts.length > 0 && !state.prompts.some(p => ASKED_FOR_TESTS.test(p))) {
      const unitFiles = changes.files.filter(f => isNew(f) && f.path.startsWith(`${unitDir}/`)).map(f => f.path)
      if (unitFiles.length > 0) signs.push(`new unit test files the user did not ask for: ${unitFiles.join(', ')}`)
    }
    if (testLines >= MIN_TEST_LINES && testLines > ratio * sourceLines) signs.push(`${testLines} test lines added for ${sourceLines} source lines changed`)
    if (newCases > maxCases) signs.push(`${newCases} new test cases`)
    for (const f of tests.filter(isNew)) {
      const own = subject(f.path)
      const mocked = f.added.flatMap(l => [...l.matchAll(MOCK_CALL)].map(m => m[1] ?? m[2] ?? m[3] ?? ''))
      if (own !== '' && mocked.some(m => baseName(m.replace(/\./g, '/')).replace(/\.[^.]+$/, '') === own || baseName(m).replace(/\.[^.]+$/, '') === own)) {
        signs.push(`${f.path} mocks the module it tests`)
      }
    }

    if (signs.length === 0) return { kind: 'allow', ruleId: ID }
    return {
      kind: 'warn',
      ruleId: ID,
      message: `You added ${newCases} tests the user did not ask for (${signs.join('; ')}). Keep only tests for edge cases an integration test cannot cover. Remove the rest, or explain in one line why each one is needed.`,
      details: { signs, testLines, sourceLines, newCases },
    }
  },
}
