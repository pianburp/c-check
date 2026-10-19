#!/usr/bin/env node
/// <reference types="node" />
// `c-check report`: counts per rule from the JSONL logs, to decide when a rule can move from observe to enforce.
// Runs in Node (not in the mod), so it may use Node built-ins. Node 23.6+ runs this .ts file directly.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { snapshot } from '../rules/git.ts'

export interface Row {
  rule: string
  mode: string
  runs: number
  warn: number
  block: number
  send_back: number
  gave_up: number
  errors: number
  right: number
  wrong: number
}

/** Tallies log lines per rule. warn/block/send_back count what the rule said, before its mode was applied. */
export function tally(lines: ReadonlyArray<Record<string, unknown>>, labels: ReadonlyArray<Record<string, unknown>> = []): Row[] {
  const rows = new Map<string, Row>()
  for (const l of lines) {
    if (typeof l.rule !== 'string') continue
    const row = rows.get(l.rule) ?? { rule: l.rule, mode: '', runs: 0, warn: 0, block: 0, send_back: 0, gave_up: 0, errors: 0, right: 0, wrong: 0 }
    rows.set(l.rule, row)
    if (l.event === 'gave_up') {
      row.gave_up += 1
      continue
    }
    row.runs += 1
    if (typeof l.mode === 'string') row.mode = l.mode
    if (l.verdict === 'warn' || l.verdict === 'block' || l.verdict === 'send_back') row[l.verdict] += 1
    if (l.event === 'error' || l.event === 'timeout') row.errors += 1
  }
  for (const l of labels) {
    if (typeof l.rule !== 'string' || (l.label !== 'right' && l.label !== 'wrong')) continue
    const row = rows.get(l.rule) ?? { rule: l.rule, mode: '', runs: 0, warn: 0, block: 0, send_back: 0, gave_up: 0, errors: 0, right: 0, wrong: 0 }
    rows.set(l.rule, row)
    row[l.label] += 1
  }
  return [...rows.values()].sort((a, b) => a.rule.localeCompare(b.rule))
}

export function format(rows: readonly Row[]): string {
  const head = ['rule', 'mode', 'runs', 'warns', 'blocks', 'send-backs', 'gave-ups', 'errors', 'labeled right', 'labeled wrong']
  const body = rows.map(r => [r.rule, r.mode, r.runs, r.warn, r.block, r.send_back, r.gave_up, r.errors, r.right, r.wrong].map(String))
  const widths = head.map((h, i) => Math.max(h.length, ...body.map(b => (b[i] as string).length)))
  const line = (cells: string[]) => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i] as number) : c.padStart(widths[i] as number))).join('  ')
  return [line(head), ...body.map(line)].join('\n')
}

export function readLogs(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .flatMap(f =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .flatMap(l => {
          try {
            return l.trim() === '' ? [] : [JSON.parse(l) as Record<string, unknown>]
          } catch {
            return [] // a torn line from a crash is skipped
          }
        }),
    )
}

function logDirOf(root: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'c-check.config.json'), 'utf8')) as { logDir?: unknown }
    if (typeof cfg.logDir === 'string' && cfg.logDir !== '') return resolve(root, cfg.logDir)
  } catch {}
  return join(root, '.c-check', 'logs')
}

/** `c-check label`: saves the session's change as an eval case (before/, after.patch, case.json) and records the label. */
async function label(session: string, rule: string, lbl: string, root: string): Promise<number> {
  if (lbl !== 'right' && lbl !== 'wrong') return fail('label must be right or wrong')
  const lines = readLogs(logDirOf(root)).filter(l => l.session === session)
  const verdict = lines.filter(l => l.rule === rule && typeof l.verdict === 'string').at(-1)?.verdict
  if (typeof verdict !== 'string') return fail(`no verdict for rule ${rule} in session ${session}`)
  const logged = lines.find(l => l.event === 'baseline')?.details as { tree?: unknown } | undefined
  if (typeof logged?.tree !== 'string') return fail(`no baseline tree logged for session ${session}`)
  const base = logged.tree
  const g = (args: string[], env?: Record<string, string>) => execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, env: { ...process.env, ...env }, maxBuffer: 1 << 28 })
  const ports = { run: async (argv: string[], o: { cwd: string; env?: Record<string, string> }) => ({ exitCode: 0, stdout: execFileSync(argv[0] as string, argv.slice(1), { cwd: o.cwd, env: { ...process.env, ...o.env }, encoding: 'utf8' }), stderr: '' }) }
  let cur: string
  try {
    cur = (await snapshot(ports as never, root, session))?.tree ?? ''
    if (cur === '') return fail('not a git repo')
    g(['cat-file', '-e', base])
  } catch {
    return fail('git failed, or the baseline tree is gone')
  }
  const dir = join(root, '.c-check', 'cases', `${session}-${rule}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'before'), { recursive: true })
  const idx = join(dir, '.index')
  g(['read-tree', base], { GIT_INDEX_FILE: idx })
  g(['checkout-index', '-a', '-f', `--prefix=${join(dir, 'before').replace(/\\/g, '/')}/`], { GIT_INDEX_FILE: idx })
  rmSync(idx)
  writeFileSync(join(dir, 'after.patch'), g(['diff', '--binary', '--no-color', '--no-ext-diff', '--no-renames', base, cur]))
  const cheat = lbl === 'right' ? verdict !== 'allow' : verdict === 'allow'
  writeFileSync(join(dir, 'case.json'), `${JSON.stringify({ label: cheat ? 'cheat' : 'clean', class: cheat ? 'unlabeled' : 'clean', mustCatch: cheat ? [rule] : [] }, null, 2)}
`)
  appendFileSync(join(root, '.c-check', 'labels.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), session, rule, label: lbl })}
`)
  console.log('Check these files for secrets before you move them into evals/cheats/.')
  return 0
}

function fail(msg: string): number {
  console.error(`c-check: ${msg}`)
  return 1
}

function readLabels(root: string): Array<Record<string, unknown>> {
  const dir = join(root, '.c-check')
  return existsSync(join(dir, 'labels.jsonl')) ? readLogs(dir).filter(l => 'label' in l) : []
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  if (command === 'label') {
    const [session, rule, lbl, dir] = rest
    if (session === undefined || rule === undefined || lbl === undefined) {
      console.error('usage: c-check label <session-id> <rule-id> right|wrong [project-dir]')
      return 2
    }
    return label(session, rule, lbl, resolve(dir ?? '.'))
  }
  if (command !== 'report') {
    console.error('usage: c-check report|label ...')
    return 2
  }
  const root = resolve(rest[0] ?? '.')
  const dir = logDirOf(root)
  const rows = tally(readLogs(dir), readLabels(root))
  if (rows.length === 0) {
    console.log(`No c-check logs in ${dir}.`)
    return 0
  }
  console.log(format(rows))
  console.log('\nwarns, blocks and send-backs count what each rule said, also in observe mode.')
  return 0
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) void main(process.argv.slice(2)).then(c => void (process.exitCode = c))
