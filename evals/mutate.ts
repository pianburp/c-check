#!/usr/bin/env node
/// <reference types="node" />
// Mutation check: breaks one rule on purpose, runs that rule's tests, and expects them to fail.
// A mutant that survives (tests still pass) marks a behavior no test pins down. Usage: node evals/mutate.ts [mutant-id ...]
// Slow (one Vitest run per mutant) and never run by CI. It edits src/ in place and always restores it, so run it on a clean tree.
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// [id, file, from, to, spec]. `from` must appear exactly once, so a refactor that moves the code fails loudly instead of testing nothing.
export const MUTANTS: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ['risky-reset-hard', 'src/rules/no-risky-commands.ts', String.raw`\breset\b[^;&|\n]*\s--hard\b`, String.raw`\breset\b[^;&|\n]*\s--hardx\b`, 'no-risky-commands'],
  ['risky-rm-flags', 'src/rules/no-risky-commands.ts', 'if (!recursive || !force) continue', 'if (!recursive && !force) continue', 'no-risky-commands'],
  ['outside-inside-check', 'src/rules/no-outside-edits.ts', "if (isInside(target, resolvePath(root, '.'))) return", "if (!isInside(target, resolvePath(root, '.'))) return", 'no-outside-edits'],
  ['weakening-lost-case', 'src/rules/no-test-weakening.ts', 'if (lost > 0)', 'if (lost > 1)', 'no-test-weakening'],
  ['weakening-skip-marker', 'src/rules/no-test-weakening.ts', 'if (skips > 0)', 'if (skips > 1)', 'no-test-weakening'],
  ['bloat-max-cases', 'src/rules/no-test-bloat.ts', 'if (newCases > maxCases)', 'if (newCases > maxCases + 1)', 'no-test-bloat'],
  ['bloat-min-lines', 'src/rules/no-test-bloat.ts', 'testLines >= MIN_TEST_LINES &&', 'testLines >= MIN_TEST_LINES * 10 &&', 'no-test-bloat'],
  ['leak-emails-min', 'src/rules/no-data-before-login.ts', 'emails: 3,', 'emails: 4,', 'no-data-before-login'],
  ['leak-ic-min', 'src/rules/no-data-before-login.ts', "'ic-numbers': 1,", "'ic-numbers': 2,", 'no-data-before-login'],
  ['tests-exit-code', 'src/rules/tests-pass-before-done.ts', 'if (result.exitCode === 0) {', 'if (result.exitCode !== 2) {', 'tests-pass-before-done'],
  ['tests-output-lines', 'src/rules/tests-pass-before-done.ts', '`${result.stdout}\\n${result.stderr}`, 50)', '`${result.stdout}\\n${result.stderr}`, 5)', 'tests-pass-before-done'],
  ['engine-max-send-backs', 'src/engine/engine.ts', 'if (n >= config.maxSendBacks) {', 'if (n > config.maxSendBacks) {', 'tests-pass-before-done'],
  ['secrets-placeholder', 'src/rules/no-secrets-in-files.ts', '|test|fake|', '|fake|', 'no-secrets-in-files'],
  ['deploy-passed-tree', 'src/rules/deploy-gate.ts', 'if (tree !== undefined && tree === state.leakCheckPassedTree) return', 'if (tree !== undefined) return', 'deploy-gate'],
  ['claimed-unreported', 'src/rules/claimed-changes-are-real.ts', 'const unreported = [...real].filter(f => !claimed.has(f))', 'const unreported: string[] = []', 'claimed-changes-are-real'],
]

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const wanted = process.argv.slice(2)
  const survived: string[] = []
  for (const [id, file, from, to, spec] of MUTANTS.filter(m => wanted.length === 0 || wanted.includes(m[0]))) {
    const path = join(ROOT, file)
    const original = readFileSync(path, 'utf8')
    if (original.split(from).length !== 2) throw new Error(`${id}: "${from}" must appear exactly once in ${file}`)
    try {
      writeFileSync(path, original.replace(from, to))
      const run = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', `tests/integration/${spec}.spec.ts`], { cwd: ROOT, encoding: 'utf8' })
      const killed = run.status !== 0
      if (!killed) survived.push(id)
      console.log(`${killed ? 'killed  ' : 'SURVIVED'}  ${id}  (${spec})`)
    } finally {
      writeFileSync(path, original)
    }
  }
  console.log(`\n${survived.length} survived${survived.length ? `: ${survived.join(', ')}. Add a test that fails on each.` : '.'}`)
  process.exitCode = survived.length > 0 ? 1 : 0
}
