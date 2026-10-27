// Scores a label sheet the owner filled in (label-sheet.csv or label-live.csv). No model; labels come only from the sheet.
// Usage: node proof/score.ts <label-sheet.csv> [--json <path>]
// Per rule: fires, real, false, unsure, false alarm rate = false / (real + false). Unsure and unlabeled rows are left out of the rate.
// Rows in group "self" (c-check's own repo) are scored apart and never mixed into the main numbers.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatRate } from '../evals/stats.ts'

const LABELS = ['real', 'false', 'unsure'] as const
type Label = (typeof LABELS)[number]

export interface RuleScore {
  fires: number
  real: number
  false: number
  unsure: number
  unlabeled: number
  /** Labels other than real, false or unsure. Left out of the rate. */
  invalid: number
  /** false / (real + false); null when nothing was labeled real or false. */
  falseAlarmRate: number | null
}

/** Rows of a CSV file. Handles quotes, a BOM and CRLF, as a spreadsheet may save them. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') (field += '"'), i++
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') row.push(field), (field = '')
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field), rows.push(row), (row = []), (field = '')
    } else field += ch
  }
  if (field !== '' || row.length > 0) row.push(field), rows.push(row)
  return rows.filter(r => r.some(f => f.trim() !== ''))
}

export function score(text: string): Record<'main' | 'self', Record<string, RuleScore>> {
  const [head, ...body] = parseCsv(text)
  const col = (name: string) => (head ?? []).findIndex(h => h.trim().toLowerCase() === name)
  const [ruleAt, labelAt, groupAt] = [col('rule'), col('label'), col('group')]
  if (ruleAt < 0 || labelAt < 0) throw new Error('The sheet needs a "rule" and a "label" column.')

  const out: Record<'main' | 'self', Record<string, RuleScore>> = { main: {}, self: {} }
  for (const row of body) {
    const rule = (row[ruleAt] ?? '').trim()
    if (rule === '') continue
    const group = (row[groupAt] ?? '').trim() === 'self' ? 'self' : 'main'
    const s = (out[group][rule] ??= { fires: 0, real: 0, false: 0, unsure: 0, unlabeled: 0, invalid: 0, falseAlarmRate: null })
    s.fires++
    const label = (row[labelAt] ?? '').trim().toLowerCase()
    if (label === '') s.unlabeled++
    else if ((LABELS as readonly string[]).includes(label)) s[label as Label]++
    else s.invalid++
  }
  for (const g of Object.values(out)) for (const s of Object.values(g)) s.falseAlarmRate = s.real + s.false > 0 ? s.false / (s.real + s.false) : null
  return out
}

function table(title: string, rules: Record<string, RuleScore>): string {
  const lines = [`## ${title}`, '', '| rule | fires | real | false | false alarm rate (95% range) |', '| :- | -: | -: | -: | :- |']
  const rest: string[] = []
  for (const [rule, s] of Object.entries(rules).sort()) {
    lines.push(`| ${rule} | ${s.fires} | ${s.real} | ${s.false} | ${formatRate(s.false, s.real + s.false)} |`)
    if (s.unsure > 0) rest.push(`- ${rule}: ${s.unsure} unsure (left out of the rate)`)
    if (s.unlabeled > 0) rest.push(`- ${rule}: ${s.unlabeled} not labeled yet (left out of the rate)`)
    if (s.invalid > 0) rest.push(`- ${rule}: ${s.invalid} with a label other than real, false or unsure (left out of the rate)`)
  }
  if (Object.keys(rules).length === 0) lines.push('| (no fires) | 0 | 0 | 0 | - |')
  return [...lines, ...(rest.length > 0 ? ['', ...rest] : [])].join('\n')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const jsonAt = args.indexOf('--json')
  const json = jsonAt >= 0 ? args[jsonAt + 1] : undefined
  const file = args.find((a, i) => !a.startsWith('--') && i !== jsonAt + 1)
  if (file === undefined) {
    console.error('Usage: node proof/score.ts <label-sheet.csv> [--json <path>]')
    process.exit(2)
  }
  const result = score(readFileSync(file, 'utf8'))
  console.log(`${table('Your work', result.main)}\n\n${table('c-check itself (group "self", never in headline numbers)', result.self)}`)
  if (json !== undefined) writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`)
}
