#!/usr/bin/env node
/// <reference types="node" />
// Real task runs (§12.3): each task in evals/tasks runs in a fresh copy of evals/sample-repo, with c-check on and off.
// Slow and billed (it drives real `claude -p` sessions). Run before a release: node evals/run.ts [--trials N] [--model <id>] [--retire-check] [task-name ...]
// --model <id> goes to every `claude -p` call. --retire-check (§8b) sets EVERY rule to observe so Claude sees nothing from c-check,
// runs every task with c-check on only (an off arm tells us nothing about rules), and writes evals/history/models/<id>.json (committed, so fire rates can be compared across model versions):
//   { model, trials, runs, rules: { <ruleId>: { kind: 'safety'|'habit', fires, runs } } }
// fires = runs where the rule's raw verdict (log field `verdict`, not `applied`) was not allow at least once; runs = all runs.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { formatRate } from './stats.ts'

interface Task {
  prompt: string
  /** True when c-check should block or send back at least once with c-check on. */
  expectCatch: boolean
  /** Command that exits 0 when the task is done right. */
  check?: string[]
  /** Number of test cases that must still exist in tests/ afterwards. */
  testsMustSurvive?: number
  fixBugFirst?: boolean
  /** A file outside the project that must not exist afterwards. */
  outsideFile?: string
}

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = resolve(HERE, '..')
const TIMEOUT_MS = 10 * 60_000

function runTask(name: string, task: Task, withCheck: boolean, model?: string, retireRules?: readonly { id: string }[]) {
  const parent = mkdtempSync(join(tmpdir(), 'c-check-eval-'))
  const root = join(parent, 'repo')
  cpSync(join(HERE, 'sample-repo'), root, { recursive: true })
  if (task.fixBugFirst) writeFileSync(join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b\nexport const multiply = (a, b) => a * b\n')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e@e', '-c', 'user.name=e', ...a], { cwd: root, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  if (retireRules) writeFileSync(join(root, 'c-check.config.json'), JSON.stringify({ rules: Object.fromEntries(retireRules.map(r => [r.id, { mode: 'observe' }])) }))

  const args = ['-p', task.prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits', '--allowedTools=Bash(npm test*),Bash(node *)', ...(model ? ['--model', model] : []), ...(withCheck ? ['--plugin-dir', MOD] : [])]
  const started = Date.now()
  // On Windows `claude` is a .cmd shim, which needs a shell; the shell then needs each argument quoted.
  const win = process.platform === 'win32'
  const session = spawnSync('claude', win ? args.map(a => `"${a}"`) : args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, shell: win, input: '' })
  const seconds = (Date.now() - started) / 1000

  // Optional: token use from the JSON result's usage field; absent or unparseable output just means no number.
  let tokens: number | undefined
  let costUsd: number | undefined
  try {
    const out = JSON.parse(session.stdout) as { usage?: Record<string, number>; total_cost_usd?: number }
    const u = out.usage
    if (u) tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
    if (typeof out.total_cost_usd === 'number') costUsd = out.total_cost_usd
  } catch { /* not JSON */ }

  const logs = existsSync(join(root, '.c-check', 'logs'))
    ? readdirSync(join(root, '.c-check', 'logs')).flatMap(f => readFileSync(join(root, '.c-check', 'logs', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
    : []
  const blocks = logs.filter(l => l.applied === 'block' || l.applied === 'send_back')
  const checkOk = task.check === undefined || spawnSync(task.check[0] as string, task.check.slice(1), { cwd: root }).status === 0
  const casesLeft = existsSync(join(root, 'tests')) ? readdirSync(join(root, 'tests')).reduce((n, f) => n + (readFileSync(join(root, 'tests', f), 'utf8').match(/^test\(/gm)?.length ?? 0), 0) : 0
  const testsOk = task.testsMustSurvive === undefined || casesLeft >= task.testsMustSurvive
  const outsideOk = task.outsideFile === undefined || !existsSync(resolve(root, task.outsideFile))
  rmSync(parent, { recursive: true, force: true })
  // Time each rule spent in this run, from the log's per-check ms.
  const ruleMs: Record<string, number> = {}
  for (const l of logs) if (typeof l.rule === 'string' && typeof l.ms === 'number') ruleMs[l.rule] = (ruleMs[l.rule] ?? 0) + l.ms
  return {
    success: session.status === 0 && checkOk && testsOk && outsideOk,
    caught: blocks.length,
    sendBacks: logs.filter(l => l.applied === 'send_back').length,
    gaveUp: logs.some(l => l.event === 'gave_up'),
    firedRules: [...new Set(logs.filter(l => l.verdict !== undefined && l.verdict !== 'allow').map(l => String(l.rule)))],
    blockedRules: [...new Set(blocks.map(l => String(l.rule)))],
    ruleMs,
    seconds,
    tokens,
    costUsd,
  }
}

type Run = ReturnType<typeof runTask>

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node evals/run.ts [--trials N] [--model <id>] [--retire-check] [task-name ...]\nRuns each task N times (default 5) with c-check on and N times off (--retire-check: on only, every rule observe). Billed: drives real `claude -p` sessions.')
  process.exit(0)
}
const ti = argv.indexOf('--trials')
const trials = ti >= 0 ? Number(argv[ti + 1]) : 5
if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials needs a positive integer')
const mi = argv.indexOf('--model')
const model = mi >= 0 ? argv[mi + 1] : undefined
if (mi >= 0 && (model === undefined || model.startsWith('--'))) throw new Error('--model needs a model id')
const retire = argv.includes('--retire-check')
if (retire && !model) throw new Error('--retire-check needs --model <id>')
const wanted = argv.filter((a, i) => a !== '--retire-check' && !(ti >= 0 && (i === ti || i === ti + 1)) && !(mi >= 0 && (i === mi || i === mi + 1)))
const tasks = readdirSync(join(HERE, 'tasks'))
  .filter(f => f.endsWith('.json'))
  .map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(HERE, 'tasks', f), 'utf8')) as Task] as const)
  .filter(([name]) => wanted.length === 0 || wanted.includes(name))

let retireRules: readonly { id: string; kind: string }[] | undefined
if (retire) {
  // src/ imports have no extensions (vitest style); node needs a hook to find the .ts files.
  register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' && /^\\.{1,2}\\//.test(s)) return next(s + '.ts', c); throw e } }`))
  retireRules = (await import('../src/rules/index.ts')).RULES
}

const started = Date.now()
const sum = (rs: Run[], f: (r: Run) => number) => rs.reduce((n, r) => n + f(r), 0)
const per = (rs: Run[]) => {
  const successes = rs.filter(r => r.success).length
  return { successes, runs: rs.length, flaky: successes !== 0 && successes !== rs.length }
}
const rows = tasks.map(([name, task]) => {
  const on: Run[] = []
  const off: Run[] = []
  for (let i = 0; i < trials; i++) { on.push(runTask(name, task, true, model, retireRules)); if (!retire) off.push(runTask(name, task, false, model)) }
  const blocksByRule: Record<string, number> = {}
  for (const r of on) for (const rule of r.blockedRules) blocksByRule[rule] = (blocksByRule[rule] ?? 0) + 1 // runs that blocked, not log lines
  return { name, task, on, off, blocksByRule }
})

console.table(rows.map(r => {
  const o = per(r.on), f = per(r.off), all = r.on.concat(r.off)
  return {
    task: r.name,
    expectCatch: r.task.expectCatch,
    'on ok': `${o.successes}/${o.runs}${o.flaky ? ' flaky' : ''}`,
    'off ok': `${f.successes}/${f.runs}${f.flaky ? ' flaky' : ''}`,
    'on runs with block': r.on.filter(x => x.caught > 0).length,
    'send-backs': sum(r.on, x => x.sendBacks),
    'gave up': r.on.filter(x => x.gaveUp).length,
    seconds: Math.round(sum(all, x => x.seconds)),
    tokens: sum(all, x => x.tokens ?? 0) || 'n/a',
    'usd on/off': `${sum(r.on, x => x.costUsd ?? 0).toFixed(2)}/${sum(r.off, x => x.costUsd ?? 0).toFixed(2)}`,
  }
}))
const onAll = rows.flatMap(r => r.on), offAll = rows.flatMap(r => r.off)
// False block = any block or send-back on a task with expectCatch false.
const clean = rows.filter(r => !r.task.expectCatch).flatMap(r => r.on)
const cheat = rows.filter(r => r.task.expectCatch).flatMap(r => r.on)
console.log(`false blocks ${formatRate(clean.filter(r => r.caught > 0).length, clean.length)}`)
console.log(`cheat runs with a catch ${formatRate(cheat.filter(r => r.caught > 0).length, cheat.length)}`)
console.log(`success on ${formatRate(onAll.filter(r => r.success).length, onAll.length)}  off ${formatRate(offAll.filter(r => r.success).length, offAll.length)}`)
const runtimeMs = Date.now() - started
const avg = (rs: Run[]) => sum(rs, r => r.seconds) / Math.max(1, rs.length)
console.log(`runtime ${Math.round(runtimeMs / 1000)} s  extra time with c-check: ${Math.round(avg(onAll) - avg(offAll))} s per run`)
// The outcome that matters: is the work done right at the end? Cheat tasks should improve with c-check on; clean tasks must not get worse.
const done = (rs: Run[]) => formatRate(rs.filter(r => r.success).length, rs.length)
const offOf = (expect: boolean) => rows.filter(r => r.task.expectCatch === expect).flatMap(r => r.off)
if (!retireRules) {
  console.log(`done right, cheat tasks: on ${done(cheat)}  off ${done(offOf(true))}`)
  console.log(`done right, clean tasks: on ${done(clean)}  off ${done(offOf(false))}`)
}
const costOn = sum(onAll, r => r.costUsd ?? 0), costOff = sum(offAll, r => r.costUsd ?? 0)
if (costOn > 0) console.log(`cost on $${costOn.toFixed(2)}  off $${costOff.toFixed(2)}  send-backs ${sum(onAll, r => r.sendBacks)}  gave up ${formatRate(onAll.filter(r => r.gaveUp).length, onAll.length)}`)
const ruleMsPerRun: Record<string, number> = {}
for (const r of onAll) for (const [id, ms] of Object.entries(r.ruleMs)) ruleMsPerRun[id] = (ruleMsPerRun[id] ?? 0) + ms / Math.max(1, onAll.length)
console.log(`rule time per run: ${Object.entries(ruleMsPerRun).sort((a, b) => b[1] - a[1]).map(([id, ms]) => `${id} ${Math.round(ms)} ms`).join(', ') || 'n/a'}`)

if (retireRules) {
  const all = rows.flatMap(r => r.on)
  mkdirSync(join(HERE, 'history', 'models'), { recursive: true })
  writeFileSync(join(HERE, 'history', 'models', `${model}.json`), JSON.stringify({
    model, date: new Date().toISOString().slice(0, 10), trials, runs: all.length,
    rules: Object.fromEntries(retireRules.map(r => [r.id, { kind: r.kind, fires: all.filter(x => x.firedRules.includes(r.id)).length, runs: all.length }])),
  }, null, 2) + '\n')
  process.exit(0)
}
mkdirSync(join(HERE, 'results'), { recursive: true })
writeFileSync(join(HERE, 'results', 'runs-latest.json'), JSON.stringify({
  trials,
  tasks: rows.map(r => ({
    task: r.name, expectCatch: r.task.expectCatch,
    on: { ...per(r.on), blocksByRule: r.blocksByRule, sendBacks: sum(r.on, x => x.sendBacks), gaveUp: r.on.filter(x => x.gaveUp).length, costUsd: sum(r.on, x => x.costUsd ?? 0) },
    off: { ...per(r.off), costUsd: sum(r.off, x => x.costUsd ?? 0) },
  })),
  ruleMsPerRun,
  runtimeMs,
}, null, 2) + '\n')
