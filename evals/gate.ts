#!/usr/bin/env node
/// <reference types="node" />
// Enforce gate (§6): per rule, is it safe to default to enforce? Usage: node evals/gate.ts [latest.json] [runs-latest.json] [labels.jsonl]
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatRate, wilson } from './stats.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIN_CLEAN = 150
const [latestPath = join(HERE, 'results', 'latest.json'), runsPath = join(HERE, 'results', 'runs-latest.json'), labelsPath = resolve(HERE, '..', '.c-check', 'labels.jsonl')] = process.argv.slice(2)

const load = (p: string): unknown => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : undefined } catch { return undefined } }
type Replay = { cases?: { label: string; verdicts?: Record<string, string> }[]; rules?: Record<string, { cleanTotal: number }> }
type Runs = { tasks?: { expectCatch: boolean; on: { runs: number; blocksByRule?: Record<string, number> } }[] }
const replay = (load(latestPath) ?? {}) as Replay
const runs = (load(runsPath) ?? {}) as Runs
const labels = existsSync(labelsPath)
  ? readFileSync(labelsPath, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as { rule: string; label: string }] } catch { return [] } })
  : []

const cleanTasks = (runs.tasks ?? []).filter(t => !t.expectCatch)
const realClean = cleanTasks.reduce((n, t) => n + t.on.runs, 0)
const rules = new Set<string>([
  ...Object.keys(replay.rules ?? {}),
  ...cleanTasks.flatMap(t => Object.keys(t.on.blocksByRule ?? {})),
  ...labels.map(l => l.rule),
])
const isBlock = (v?: string) => v === 'block' || v === 'send_back' // warn is not a false block

for (const rule of [...rules].sort()) {
  const replayClean = replay.rules?.[rule]?.cleanTotal ?? 0
  const clean = replayClean + realClean
  const falseBlocks =
    (replay.cases ?? []).filter(c => c.label === 'clean' && isBlock(c.verdicts?.[rule])).length +
    cleanTasks.reduce((n, t) => n + (t.on.blocksByRule?.[rule] ?? 0), 0)
  const wrong = labels.filter(l => l.rule === rule && l.label === 'wrong').length
  const why = [
    clean < MIN_CLEAN ? `needs ${MIN_CLEAN - clean} more clean runs` : '',
    falseBlocks > 0 ? `${falseBlocks} false block(s)` : '',
    wrong > 0 ? `${wrong} "wrong" label(s)` : '',
  ].filter(Boolean)
  const upper = (wilson(falseBlocks, clean).hi * 100).toFixed(1)
  console.log(`${rule}: clean runs ${clean} (replay ${replayClean}, real ${realClean})  false blocks ${formatRate(falseBlocks, clean)}  upper bound ${upper}%  ${why.length ? `not ready: ${why.join('; ')}` : 'ready'}`)
}
if (rules.size === 0) console.log('no results yet: run `node evals/replay.ts --json evals/results/latest.json` and `node evals/run.ts`')
