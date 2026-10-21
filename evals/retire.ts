#!/usr/bin/env node
/// <reference types="node" />
// Rule retirement report (§8b). Usage: node evals/retire.ts <model-id|file> [previous-model-id|file]
// With no arguments: the fire-rate history of every rule across every model in evals/history/models/, oldest first.
// Reads evals/history/models/<id>.json (written by `node evals/run.ts --model <id> --retire-check`), or a direct path.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatRate } from './stats.ts'

export const MIN_RUNS = 150 // 0 fires in 150 runs puts the 95% upper bound under 2%

export interface ModelResult { model: string; date?: string; trials: number; runs: number; rules: Record<string, { kind: 'safety' | 'habit'; fires: number; runs: number }> }

export function retireVerdict(kind: 'safety' | 'habit', fires: number, runs: number): string {
  if (kind === 'safety') return 'keep (safety)'
  if (fires > 0) return 'keep'
  return runs >= MIN_RUNS ? 'retire?' : 'unclear'
}

/** One row per rule, one column per model (oldest first), and the newest model's verdict. */
export function historyTable(results: readonly ModelResult[]): string {
  const sorted = [...results].sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  const rules = [...new Set(sorted.flatMap(r => Object.keys(r.rules)))].sort()
  const last = sorted.at(-1)
  const rate = (r?: { fires: number; runs: number }) => (r ? formatRate(r.fires, r.runs) : 'n/a')
  const head = `| rule | ${sorted.map(r => `${r.model}${r.date ? ` (${r.date})` : ''}`).join(' | ')} | verdict |\n| :- |${' :- |'.repeat(sorted.length)} :- |`
  const rows = rules.map(id => {
    const now = last?.rules[id]
    return `| ${id} | ${sorted.map(r => rate(r.rules[id])).join(' | ')} | ${now ? retireVerdict(now.kind, now.fires, now.runs) : 'n/a'} |`
  })
  return [head, ...rows].join('\n')
}

const HERE = dirname(fileURLToPath(import.meta.url))
const DIR = join(HERE, 'history', 'models')
const load = (id: string): ModelResult => {
  const p = existsSync(id) ? id : join(DIR, `${id}.json`)
  if (!existsSync(p)) throw new Error(`no result file for "${id}" (looked at ${p})`)
  return JSON.parse(readFileSync(p, 'utf8')) as ModelResult
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [nowId, prevId] = process.argv.slice(2)
  if (!nowId) {
    const all = existsSync(DIR) ? readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => load(join(DIR, f))) : []
    console.log(all.length ? historyTable(all) : 'No retire runs yet: node evals/run.ts --model <id> --retire-check --trials 10')
  } else {
    const now = load(nowId), prev = prevId ? load(prevId) : undefined
    const rate = (r?: { fires: number; runs: number }) => (r ? formatRate(r.fires, r.runs) : 'n/a')
    console.log(`| rule | kind | fire rate (${prev?.model ?? 'prev'}) | fire rate (${now.model}) | verdict |\n| :- | :- | :- | :- | :- |`)
    for (const [id, r] of Object.entries(now.rules)) console.log(`| ${id} | ${r.kind} | ${rate(prev?.rules[id])} | ${rate(r)} | ${retireVerdict(r.kind, r.fires, r.runs)} |`)
  }
}
