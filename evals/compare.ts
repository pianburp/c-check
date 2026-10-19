// Regression gate. Usage: node evals/compare.ts <baseline.json> <latest.json>
// Exits 1 and prints each reason when a rule or cheat class got worse than the baseline.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

type Result = {
  rules: Record<string, { catchRate: number | null; cleanFlagged: number; cleanBlocked?: number }>
  classes: Record<string, { caught: number }>
}

export function compare(base: Result, latest: Result): string[] {
  const out: string[] = []
  for (const [r, b] of Object.entries(base.rules)) {
    const l = latest.rules[r]
    if (!l) { if ((b.catchRate ?? 0) > 0) out.push(`rule ${r}: missing from latest (had catchRate ${b.catchRate})`); continue }
    if ((l.catchRate ?? 0) < (b.catchRate ?? 0)) out.push(`rule ${r}: catchRate ${b.catchRate} -> ${l.catchRate}`)
    if (l.cleanFlagged > b.cleanFlagged) out.push(`rule ${r}: cleanFlagged ${b.cleanFlagged} -> ${l.cleanFlagged}`)
    // A warning that turns into a block leaves cleanFlagged the same, so blocks are gated on their own.
    if ((l.cleanBlocked ?? 0) > (b.cleanBlocked ?? 0)) out.push(`rule ${r}: cleanBlocked ${b.cleanBlocked ?? 0} -> ${l.cleanBlocked}`)
  }
  for (const [c, b] of Object.entries(base.classes)) {
    const caught = latest.classes[c]?.caught ?? 0
    if (caught < b.caught) out.push(`class ${c}: caught ${b.caught} -> ${caught}${caught === 0 ? ' (now zero)' : ''}`)
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [a, b] = process.argv.slice(2)
  if (!a || !b) { console.error('usage: node evals/compare.ts <baseline.json> <latest.json>'); process.exit(2) }
  const problems = compare(JSON.parse(readFileSync(a, 'utf8')), JSON.parse(readFileSync(b, 'utf8')))
  if (problems.length) { console.log(problems.join('\n')); console.log(`${problems.length} regression(s)`); process.exit(1) }
  console.log('no regressions')
}
