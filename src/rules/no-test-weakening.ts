import { baseName } from '../engine/paths'
import type { Rule } from '../engine/types'
import { isTestPath, sessionChanges, showAt, type FileDiff } from './git'

const ID = 'no-test-weakening'

// shortcut: line regexes, not a parser; a test case written across lines in an unusual style can slip by. Upgrade to per-language AST if logs show misses.
export const TEST_CASE = /^\s*(?:(?:it|test|specify)(?:\.each\s*(?:\(.*?\)|`[^`]*`))?\s*\(|def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|@Test\b|#\[test\])/
const SKIP_MARKER =
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe|xcontext|fit|fdescribe|ftest)\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.skip\s*\(|@unittest\.skip|@Disabled\b|@Ignore\b|\bt\.Skip(?:Now|f)?\s*\(|#\[ignore\]/
const NARROWING = /\|\|\s*(?:true|exit\s+0)|;\s*exit\s+0|--passWithNoTests|--testNamePattern|--testPathPattern|--testPathIgnorePatterns|\s-t\s|--grep\b|\s-k\s|--deselect|--ignore\b|--exclude\b/
const COVERAGE = /\b(branches|functions|lines|statements|threshold|fail_under|fail-under|min_coverage|minimum_coverage)\b\D{0,20}(\d+(?:\.\d+)?)/i
const TEST_CONFIG = /(^|\/)(jest|vitest|vite|karma|mocha|ava|playwright|cypress)\.config\.[^/]+$|(^|\/)(\.mocharc[^/]*|\.nycrc[^/]*|pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml|phpunit\.xml[^/]*|\.c8rc[^/]*)$/
const EXCLUDE_KEY = /\b(exclude|testPathIgnorePatterns|modulePathIgnorePatterns|ignore|testIgnore|norecursedirs|addopts)\b/

const count = (lines: readonly string[], re: RegExp) => lines.filter(l => re.test(l)).length

function coverageDrops(file: FileDiff): string[] {
  const before = new Map<string, number>()
  for (const l of file.removed) {
    const m = COVERAGE.exec(l)
    if (m) before.set((m[1] as string).toLowerCase(), Number(m[2]))
  }
  const drops: string[] = []
  for (const l of file.added) {
    const m = COVERAGE.exec(l)
    const key = m?.[1]?.toLowerCase()
    const old = key !== undefined ? before.get(key) : undefined
    if (m && old !== undefined && Number(m[2]) < old) drops.push(`${file.path}: ${key} ${old} -> ${m[2]}`)
  }
  return drops
}

const testScriptOf = (pkg: string | null): string | undefined => {
  try {
    const s = pkg === null ? undefined : (JSON.parse(pkg) as { scripts?: { test?: unknown } }).scripts?.test
    return typeof s === 'string' ? s : undefined
  } catch {
    return undefined
  }
}

export const noTestWeakening: Rule = {
  id: ID,
  description: 'Partner of tests-pass-before-done: catches deleted, skipped, or narrowed tests in the session diff.',
  points: ['end'],
  kind: 'habit',
  defaultMode: 'enforce',
  async check(event, ctx) {
    const changes = await sessionChanges(ctx)
    if (changes === null) return { kind: 'allow', ruleId: ID, details: { skipped: 'no git' } }

    const findings: string[] = []
    const added = new Set(changes.files.filter(f => f.status === 'A' && isTestPath(f.path)).map(f => baseName(f.path)))
    for (const f of changes.files) {
      const isTest = isTestPath(f.path)
      // A test file deleted here and added elsewhere under the same name is a move, not a deletion.
      if (isTest && f.status === 'D' && !added.has(baseName(f.path))) findings.push(`deleted test file ${f.path}`)
      if (isTest && f.status !== 'D') {
        const lost = count(f.removed, TEST_CASE) - count(f.added, TEST_CASE)
        if (lost > 0) findings.push(`removed ${lost} test case${lost === 1 ? '' : 's'} in ${f.path}`)
      }
      const skips = count(f.added, SKIP_MARKER) - count(f.removed, SKIP_MARKER)
      if (skips > 0) findings.push(`added ${skips} skip/focus marker${skips === 1 ? '' : 's'} in ${f.path}`)
      if (TEST_CONFIG.test(f.path) || f.path === 'package.json') {
        findings.push(...coverageDrops(f).map(d => `lowered coverage threshold (${d})`))
        if (TEST_CONFIG.test(f.path) && count(f.added, EXCLUDE_KEY) > count(f.removed, EXCLUDE_KEY)) findings.push(`added test exclusions in ${f.path}`)
      }
      if (f.path === 'c-check.config.json') findings.push('changed c-check.config.json')
    }

    if (changes.files.some(f => f.path === 'package.json')) {
      const [oldScript, newScript] = await Promise.all([
        showAt(ctx.ports, event.projectRoot, changes.baseline.tree, 'package.json').then(testScriptOf),
        showAt(ctx.ports, event.projectRoot, changes.current.tree, 'package.json').then(testScriptOf),
      ])
      if (oldScript !== undefined && oldScript !== newScript && (newScript === undefined || NARROWING.test(` ${newScript} `) || newScript.length < oldScript.length)) {
        findings.push('narrowed the test script in package.json')
      }
    }

    if (findings.length === 0) return { kind: 'allow', ruleId: ID }
    return {
      kind: 'send_back',
      ruleId: ID,
      message: `Tests were weakened in this session: ${findings.join('; ')}. Do not delete, skip, or narrow tests to make them pass. Fix the code. If the user asked you to remove these tests, say so in your final message and stop.`,
      details: { findings },
    }
  },
}
