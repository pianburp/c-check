#!/usr/bin/env node
/// <reference types="node" />
// `c-check report`: counts per rule from the JSONL logs, to decide when a rule can move from observe to enforce.
// Runs in Node (not in the mod), so it may use Node built-ins. Node 23.6+ runs this .ts file directly.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

export interface Row {
  rule: string
  mode: string
  runs: number
  warn: number
  block: number
  send_back: number
  gave_up: number
  errors: number
}

/** Tallies log lines per rule. warn/block/send_back count what the rule said, before its mode was applied. */
export function tally(lines: ReadonlyArray<Record<string, unknown>>): Row[] {
  const rows = new Map<string, Row>()
  for (const l of lines) {
    if (typeof l.rule !== 'string') continue
    const row = rows.get(l.rule) ?? { rule: l.rule, mode: '', runs: 0, warn: 0, block: 0, send_back: 0, gave_up: 0, errors: 0 }
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
  return [...rows.values()].sort((a, b) => a.rule.localeCompare(b.rule))
}

export function format(rows: readonly Row[]): string {
  const head = ['rule', 'mode', 'runs', 'warns', 'blocks', 'send-backs', 'gave-ups', 'errors']
  const body = rows.map(r => [r.rule, r.mode, r.runs, r.warn, r.block, r.send_back, r.gave_up, r.errors].map(String))
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

function main(argv: string[]): number {
  const [command, ...rest] = argv
  if (command !== 'report') {
    console.error('usage: c-check report [project-dir]')
    return 2
  }
  const root = resolve(rest[0] ?? '.')
  const dir = logDirOf(root)
  const rows = tally(readLogs(dir))
  if (rows.length === 0) {
    console.log(`No c-check logs in ${dir}.`)
    return 0
  }
  console.log(format(rows))
  console.log('\nwarns, blocks and send-backs count what each rule said, also in observe mode.')
  return 0
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) process.exitCode = main(process.argv.slice(2))
