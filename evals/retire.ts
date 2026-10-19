#!/usr/bin/env node
/// <reference types="node" />
// Rule retirement report (§8b). Usage: node evals/retire.ts <model-id|file> [previous-model-id|file]
// Reads evals/results/models/<id>.json (written by `node evals/run.ts --model <id> --retire-check`), or a direct path.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatRate } from './stats.ts'

export const MIN_RUNS = 150 // 0 fires in 150 runs puts the 95% upper bound under 2%

export interface ModelResult { model: string; trials: number; runs: number; rules: Record<string, { kind: 'safety' | 'habit'; fires: number; runs: number }> }

export function retireVerdict(kind: 'safety' | 'habit', fires: number, runs: number): string {
  if (kind === 'safety') return 'keep (safety)'
  if (fires > 0) return 'keep'
  return runs >= MIN_RUNS ? 'retire?' : 'unclear'
}

const HERE = dirname(fileURLToPath(import.meta.url))
const load = (id: string): ModelResult => {
  const p = existsSync(id) ? id : join(HERE, 'results', 'models', `${id}.json`)
  if (!existsSync(p)) throw new Error(`no result file for "${id}" (looked at ${p})`)
  return JSON.parse(readFileSync(p, 'utf8')) as ModelResult
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [nowId, prevId] = process.argv.slice(2)
  if (!nowId) { console.error('usage: node evals/retire.ts <model-id> [previous-model-id]'); process.exit(1) }
  const now = load(nowId), prev = prevId ? load(prevId) : undefined
  const rate = (r?: { fires: number; runs: number }) => (r ? formatRate(r.fires, r.runs) : 'n/a')
  console.log(`| rule | kind | fire rate (${prev?.model ?? 'prev'}) | fire rate (${now.model}) | verdict |\n| :- | :- | :- | :- | :- |`)
  for (const [id, r] of Object.entries(now.rules)) console.log(`| ${id} | ${r.kind} | ${rate(prev?.rules[id])} | ${rate(r)} | ${retireVerdict(r.kind, r.fires, r.runs)} |`)
}
