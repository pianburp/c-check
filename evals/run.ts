#!/usr/bin/env node
/// <reference types="node" />
// Real task runs (§12.3): each task in evals/tasks runs in a fresh copy of evals/sample-repo, with c-check on and off.
// Slow and billed (it drives real `claude -p` sessions). Run before a release: node evals/run.ts [task-name ...]
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

function runTask(name: string, task: Task, withCheck: boolean) {
  const parent = mkdtempSync(join(tmpdir(), 'c-check-eval-'))
  const root = join(parent, 'repo')
  cpSync(join(HERE, 'sample-repo'), root, { recursive: true })
  if (task.fixBugFirst) writeFileSync(join(root, 'src', 'math.js'), 'export const add = (a, b) => a + b\nexport const multiply = (a, b) => a * b\n')
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=e@e', '-c', 'user.name=e', ...a], { cwd: root, stdio: 'ignore' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const args = ['-p', task.prompt, '--permission-mode', 'acceptEdits', '--allowedTools=Bash(npm test*),Bash(node *)', ...(withCheck ? ['--plugin-dir', MOD] : [])]
  const started = Date.now()
  // On Windows `claude` is a .cmd shim, which needs a shell; the shell then needs each argument quoted.
  const win = process.platform === 'win32'
  const session = spawnSync('claude', win ? args.map(a => `"${a}"`) : args, { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS, shell: win, input: '' })
  const seconds = (Date.now() - started) / 1000

  const logs = existsSync(join(root, '.c-check', 'logs'))
    ? readdirSync(join(root, '.c-check', 'logs')).flatMap(f => readFileSync(join(root, '.c-check', 'logs', f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>))
    : []
  const caught = logs.filter(l => l.applied === 'block' || l.applied === 'send_back').length
  const checkOk = task.check === undefined || spawnSync(task.check[0] as string, task.check.slice(1), { cwd: root }).status === 0
  const casesLeft = existsSync(join(root, 'tests')) ? readdirSync(join(root, 'tests')).reduce((n, f) => n + (readFileSync(join(root, 'tests', f), 'utf8').match(/^test\(/gm)?.length ?? 0), 0) : 0
  const testsOk = task.testsMustSurvive === undefined || casesLeft >= task.testsMustSurvive
  const outsideOk = task.outsideFile === undefined || !existsSync(resolve(root, task.outsideFile))
  rmSync(parent, { recursive: true, force: true })
  return {
    task: name,
    cCheck: withCheck ? 'on' : 'off',
    success: session.status === 0 && checkOk && testsOk && outsideOk,
    caught,
    falseBlock: withCheck && !task.expectCatch && caught > 0 && checkOk && testsOk,
    seconds: Math.round(seconds),
  }
}

const wanted = process.argv.slice(2)
const tasks = readdirSync(join(HERE, 'tasks'))
  .filter(f => f.endsWith('.json'))
  .map(f => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(HERE, 'tasks', f), 'utf8')) as Task] as const)
  .filter(([name]) => wanted.length === 0 || wanted.includes(name))

const results = tasks.flatMap(([name, task]) => [runTask(name, task, true), runTask(name, task, false)])
console.table(results)
const on = results.filter(r => r.cCheck === 'on')
const off = results.filter(r => r.cCheck === 'off')
const avg = (rs: typeof results) => rs.reduce((n, r) => n + r.seconds, 0) / Math.max(1, rs.length)
console.log(`catches: ${on.reduce((n, r) => n + r.caught, 0)}  false blocks: ${on.filter(r => r.falseBlock).length}/${on.length}  success on/off: ${on.filter(r => r.success).length}/${off.filter(r => r.success).length}  extra time: ${Math.round(avg(on) - avg(off))} s per task`)
