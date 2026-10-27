// Reads c-check's own logs from projects that ran it (observe mode) and writes the same shape as replay-sessions.ts, for all rules.
// Usage: node proof/live-report.ts <project-dir>... [--self <path>]... [--out <dir>]
//   project-dir: a project that ran c-check; its logs are read from logDir in its c-check.config.json, else .c-check/logs.
//   --self: c-check checkouts whose logs are reported apart (default: this repo). --out: default proof/.
// Only counts, rule and pattern or detector names, session ids, timestamps, tool use ids and times leave this script.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLogs } from '../src/cli/c-check.ts'

const here = dirname(fileURLToPath(import.meta.url))

interface Counts {
  total: number
  byPattern: Record<string, number>
}
interface Time {
  checks: number
  medianMs: number | null
  slowestMs: number | null
}
interface Group {
  projects: number
  sessions: number
  checks: number
  fires: Record<string, Counts>
  errors: Record<string, number>
  /** Time each rule check took, per point. Every check is logged, allows too. */
  time: Record<string, Time>
}
export interface LiveSummary {
  logLines: number
  dateRange: { from: string | null; to: string | null }
  main: Group
  self: Group
}

const norm = (p: string) => resolve(p).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const isInside = (dir: string, roots: readonly string[]) => roots.some(r => norm(dir) === norm(r) || norm(dir).startsWith(`${norm(r)}/`))
const csv = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))

function logDirOf(root: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(root, 'c-check.config.json'), 'utf8')) as { logDir?: unknown }
    if (typeof cfg.logDir === 'string' && cfg.logDir !== '') return resolve(root, cfg.logDir)
  } catch {}
  return join(root, '.c-check', 'logs')
}

/** Pattern or detector names from a log line's details. Everything else in details (paths, commands, findings) is dropped. */
function patternsOf(details: unknown): string[] {
  const d = (typeof details === 'object' && details !== null ? details : {}) as { pattern?: unknown; patterns?: unknown; routes?: unknown }
  const names = (v: unknown) => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : [])
  if (typeof d.pattern === 'string') return [d.pattern]
  const found = [...names(d.patterns), ...(Array.isArray(d.routes) ? d.routes.flatMap(r => names((r as { detectors?: unknown })?.detectors)) : [])]
  return found.length > 0 ? [...new Set(found)] : ['-']
}

function timeOf(ms: number[]): Time {
  const s = [...ms].sort((a, b) => a - b)
  const mid = s.length / 2
  const median = s.length === 0 ? null : s.length % 2 === 1 ? (s[Math.floor(mid)] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2
  return { checks: s.length, medianMs: median, slowestMs: s.at(-1) ?? null }
}

export function liveReport(projects: readonly string[], selfRoots: readonly string[]): { summary: LiveSummary; sheet: string } {
  const rows: string[] = ['session_id,agent_id,group,timestamp,position,tool_use_id,rule,pattern,label']
  const newGroup = () => ({ projects: 0, sessions: new Set<string>(), checks: 0, fires: {} as Record<string, Counts>, errors: {} as Record<string, number>, ms: {} as Record<string, number[]> })
  const groups = { main: newGroup(), self: newGroup() }
  let logLines = 0
  let from: string | null = null
  let to: string | null = null

  for (const project of projects) {
    const name = isInside(project, selfRoots) ? 'self' : 'main'
    const g = groups[name]
    const dir = logDirOf(project)
    if (!existsSync(dir)) continue
    g.projects++
    for (const line of readLogs(dir)) {
      logLines++
      const rule = typeof line.rule === 'string' ? line.rule : undefined
      const session = typeof line.session === 'string' ? line.session : ''
      const ts = typeof line.ts === 'string' ? line.ts : ''
      if (rule === undefined || line.event === 'gave_up') continue
      g.sessions.add(session)
      if (ts !== '') {
        if (from === null || ts < from) from = ts
        if (to === null || ts > to) to = ts
      }
      // A check that crashed or timed out still cost its time, so it counts in time and checks, not in fires.
      g.checks++
      const point = typeof line.point === 'string' ? line.point : 'unknown'
      if (typeof line.ms === 'number') (g.ms[point] ??= []).push(line.ms)
      if (line.event === 'error' || line.event === 'timeout') {
        g.errors[rule] = (g.errors[rule] ?? 0) + 1
        continue
      }
      if (line.verdict === undefined || line.verdict === 'allow') continue
      const patterns = patternsOf(line.details)
      const c = (g.fires[rule] ??= { total: 0, byPattern: {} })
      c.total++
      for (const p of patterns) c.byPattern[p] = (c.byPattern[p] ?? 0) + 1
      const id = typeof line.toolUseId === 'string' ? line.toolUseId : ''
      rows.push([session, '', name, ts, '', id, rule, patterns.join('; '), ''].map(csv).join(','))
    }
  }

  const done = (g: ReturnType<typeof newGroup>): Group => ({
    projects: g.projects,
    sessions: g.sessions.size,
    checks: g.checks,
    fires: g.fires,
    errors: g.errors,
    time: Object.fromEntries(Object.entries(g.ms).sort().map(([p, ms]) => [p, timeOf(ms)])),
  })
  return { summary: { logLines, dateRange: { from, to }, main: done(groups.main), self: done(groups.self) }, sheet: `${rows.join('\n')}\n` }
}

function printGroup(title: string, g: Group): void {
  console.log(`\n${title}: ${g.projects} projects, ${g.sessions} sessions, ${g.checks} checks`)
  for (const [rule, c] of Object.entries(g.fires).sort()) console.log(`  ${rule}: ${c.total} fires (${Object.entries(c.byPattern).map(([p, n]) => `${p}: ${n}`).join(', ')})`)
  if (Object.keys(g.fires).length === 0) console.log('  no fires')
  for (const [rule, n] of Object.entries(g.errors)) console.log(`  ${rule}: ${n} errors (rule threw or timed out; counted as allow)`)
  for (const [point, t] of Object.entries(g.time)) console.log(`  time at ${point}: median ${t.medianMs} ms, slowest ${t.slowestMs} ms over ${t.checks} checks`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const self: string[] = []
  const projects: string[] = []
  let out = here
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--self') self.push(args[++i] ?? '')
    else if (a === '--out') out = args[++i] ?? out
    else projects.push(a)
  }
  if (projects.length === 0) {
    console.error('Usage: node proof/live-report.ts <project-dir>... [--self <path>]... [--out <dir>]')
    process.exit(2)
  }
  const { summary, sheet } = liveReport(projects, self.length > 0 ? self : [dirname(here)])
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'results-live.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(out, 'label-live.csv'), sheet)
  console.log(`Read ${summary.logLines} log lines, ${summary.dateRange.from ?? '-'} to ${summary.dateRange.to ?? '-'}.`)
  printGroup('Your work', summary.main)
  printGroup('c-check itself (group "self", never in headline numbers)', summary.self)
  console.log('\nWrote results-live.json and label-live.csv to the output folder. Label it, then: node proof/score.ts <output-folder>/label-live.csv')
}
