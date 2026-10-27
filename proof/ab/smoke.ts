// Phase 6 step 1: one tiny paid run of `claude -p` with c-check loaded, to prove the mod loads and its rules run.
// Usage: node proof/ab/smoke.ts [--model haiku] [--budget 0.50]
// CALLS A REAL MODEL AND COSTS MONEY. Run only after the owner says yes. --max-budget-usd caps the spend.
// Prints only counts, rule names, turns and cost: never the model's text.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const opt = (name: string, fallback: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback)
const model = opt('--model', 'haiku')
const budget = opt('--budget', '0.50')

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'c-check-smoke-')))
const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'ignore' })
try {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'smoke', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2))
  cpSync(join(repo, 'proof', 'observe-config.json'), join(dir, 'c-check.config.json'))
  writeFileSync(join(dir, '.gitignore'), '.c-check/\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const env = { ...process.env }
  delete env.C_CHECK_CHILD // c-check turns itself off under this flag
  const started = Date.now()
  const run = spawnSync(
    'claude',
    ['-p', 'Create a file named hello.txt that contains the word hi. Then stop.', '--plugin-dir', repo, '--model', model, '--output-format', 'json', '--max-budget-usd', budget, '--permission-mode', 'acceptEdits', '--allowedTools', 'Write'],
    { cwd: dir, env, encoding: 'utf8', timeout: 300_000, shell: process.platform === 'win32' },
  )
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  let result: Record<string, unknown> = {}
  try {
    result = JSON.parse(run.stdout)
  } catch {}

  const logDir = join(dir, '.c-check', 'logs')
  let lines: Array<Record<string, unknown>> = []
  try {
    lines = readdirSync(logDir).flatMap(f => readFileSync(join(logDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
  } catch {}
  const byRule: Record<string, number> = {}
  for (const l of lines) if (typeof l.rule === 'string') byRule[`${l.point}:${l.rule}`] = (byRule[`${l.point}:${l.rule}`] ?? 0) + 1

  console.log(`claude exit code: ${run.status}${run.error ? ` (${run.error.message})` : ''}, ${seconds}s`)
  console.log(`turns: ${result.num_turns ?? '?'}, cost: $${result.total_cost_usd ?? '?'}, error: ${result.is_error ?? '?'}`)
  console.log(`c-check log lines: ${lines.length}`)
  for (const [k, n] of Object.entries(byRule).sort()) console.log(`  ${k}: ${n}`)
  const loaded = Object.keys(byRule).length > 0
  console.log(loaded ? 'c-check loaded and its rules ran.' : 'c-check did NOT run: no rule lines in its log. The A/B test is not valid until this is fixed.')
  process.exitCode = loaded ? 0 : 1
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
}
