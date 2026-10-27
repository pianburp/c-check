// Replays old Claude Code sessions through c-check's own tool-call rules. No model, no network, no processes.
// Usage: node proof/replay-sessions.ts [sessions-dir] [--self <path>]... [--out <dir>]
//   sessions-dir: default ~/.claude/projects/.  --self: c-check checkouts whose sessions are reported apart (default: this repo).
//   --out: where results-sessions.json and label-sheet.csv go (default: proof/).
// Only counts, rule and pattern names, session ids, timestamps and positions leave this script: never commands, file text or paths.
import { register } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// src/ imports without extensions (vitest style); node needs a hook to find the .ts files.
register(
  'data:text/javascript,' +
    encodeURIComponent(
      `export async function resolve(s, c, next) { try { return await next(s, c) } catch (e) { if (e.code === 'ERR_MODULE_NOT_FOUND' && /^\\.{1,2}\\//.test(s)) return next(s + '.ts', c); throw e } }`,
    ),
)
const { runEvent } = await import('../src/engine/engine.ts')
const { newSessionState } = await import('../src/engine/types.ts')
const { RULES } = await import('../src/rules/index.ts')
const { DEFAULT_DIR, readToolCalls } = await import('./transcripts.ts')
type Logger = import('../src/log/log.ts').Logger
type LogLine = import('../src/log/log.ts').LogLine
type Ports = import('../src/engine/types.ts').Ports
type SessionState = import('../src/engine/types.ts').SessionState

const here = dirname(fileURLToPath(import.meta.url))
const DEPLOY_RULE = 'deploy-gate'

// The engine reads config through ports: returning null for every read gives the default config, and keeps the replay off the disk.
const ports: Ports = {
  run: async () => {
    throw new Error('replay runs no processes')
  },
  read: async () => null,
  write: async () => {},
  realPath: async () => undefined,
  now: async () => Date.now(),
}

interface Counts {
  total: number
  byPattern: Record<string, number>
}
interface Group {
  sessions: number
  toolCalls: number
  fires: Record<string, Counts>
  errors: Record<string, number>
  /** deploy-gate needs the leak check's state, which old sessions do not have: a count of deploy commands, no block claim. */
  deployCommandsSeen: Counts
}

const norm = (p: string) => p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
const isInside = (project: string, roots: readonly string[]) => roots.some(r => norm(project) === norm(r) || norm(project).startsWith(`${norm(r)}/`))

/** Pattern or detector names from a verdict's details. Anything else in details (paths, targets) is dropped. */
function patternsOf(rule: string, details: unknown): string[] {
  const d = (typeof details === 'object' && details !== null ? details : {}) as { pattern?: unknown; patterns?: unknown }
  if (typeof d.pattern === 'string') return [d.pattern]
  if (Array.isArray(d.patterns)) return d.patterns.filter((p): p is string => typeof p === 'string')
  return rule === 'no-outside-edits' ? ['outside project'] : ['-']
}

const csv = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))
const add = (c: Counts, pattern: string) => {
  c.total++
  c.byPattern[pattern] = (c.byPattern[pattern] ?? 0) + 1
}

export interface Summary {
  sessionsRead: number
  filesRead: number
  badLines: number
  dateRange: { from: string | null; to: string | null }
  main: Group
  self: Group
}

export async function replaySessions(dir: string, selfRoots: readonly string[]): Promise<{ summary: Summary; sheet: string }> {
  const newGroup = (): Group => ({ sessions: 0, toolCalls: 0, fires: {}, errors: {}, deployCommandsSeen: { total: 0, byPattern: {} } })
  const groups = { main: newGroup(), self: newGroup() }
  const states = new Map<string, SessionState>()
  const stats = { files: 0, badLines: 0 }
  const rows: string[] = ['session_id,agent_id,group,timestamp,position,tool_use_id,rule,pattern,label']
  let from: string | null = null
  let to: string | null = null

  for await (const call of readToolCalls(dir, stats)) {
    const groupName = isInside(call.project, selfRoots) ? 'self' : 'main'
    const group = groups[groupName]
    // A subagent shares its parent's session id but keeps its own memory, as it does in Claude Code.
    const key = `${call.sessionId}\0${call.agentId ?? ''}`
    let state = states.get(key)
    if (state === undefined) {
      state = newSessionState(call.sessionId, call.project)
      states.set(key, state)
      if (call.agentId === undefined) group.sessions++
    }
    group.toolCalls++
    if (call.timestamp !== undefined) {
      if (from === null || call.timestamp < from) from = call.timestamp
      if (to === null || call.timestamp > to) to = call.timestamp
    }

    const lines: LogLine[] = []
    const logger = { write: async (line: LogLine) => void lines.push(line) } as unknown as Logger
    const base = { sessionId: call.sessionId, projectRoot: call.project, tool: call.tool, input: call.input, timestamp: call.timestamp ?? '' }
    await runEvent({ ...base, point: 'before' }, { rules: RULES, ports, state, logger })
    await runEvent({ ...base, point: 'after', output: { isError: call.isError } }, { rules: RULES, ports, state, logger })

    for (const line of lines) {
      if (line.rule === undefined) continue
      if (line.event === 'error' || line.event === 'timeout') {
        group.errors[line.rule] = (group.errors[line.rule] ?? 0) + 1
        continue
      }
      const patterns = patternsOf(line.rule, line.details)
      if (line.rule === DEPLOY_RULE) {
        if (patterns[0] !== '-') add(group.deployCommandsSeen, patterns[0] as string)
        continue
      }
      if (line.verdict === undefined || line.verdict === 'allow') continue
      const counts = (group.fires[line.rule] ??= { total: 0, byPattern: {} })
      for (const p of patterns) add(counts, p)
      rows.push([call.sessionId, call.agentId ?? '', groupName, call.timestamp ?? '', call.position, call.toolUseId ?? '', line.rule, patterns.join('; '), ''].map(csv).join(','))
    }
  }

  const sessionsRead = groups.main.sessions + groups.self.sessions
  return { summary: { sessionsRead, filesRead: stats.files, badLines: stats.badLines, dateRange: { from, to }, ...groups }, sheet: `${rows.join('\n')}\n` }
}

function printGroup(name: string, g: Group): void {
  console.log(`\n${name}: ${g.sessions} sessions, ${g.toolCalls} tool calls`)
  for (const [rule, c] of Object.entries(g.fires).sort()) {
    console.log(`  ${rule}: ${c.total} fires (${Object.entries(c.byPattern).map(([p, n]) => `${p}: ${n}`).join(', ')})`)
  }
  if (Object.keys(g.fires).length === 0) console.log('  no fires')
  for (const [rule, n] of Object.entries(g.errors)) console.log(`  ${rule}: ${n} errors (rule threw or timed out; counted as allow)`)
  console.log(`  deploy commands seen (count only, no block claim): ${g.deployCommandsSeen.total}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const self: string[] = []
  let out = here
  let dir = DEFAULT_DIR
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (a === '--self') self.push(args[++i] ?? '')
    else if (a === '--out') out = args[++i] ?? out
    else dir = a
  }
  const { summary, sheet } = await replaySessions(dir, self.length > 0 ? self : [dirname(here)])
  mkdirSync(out, { recursive: true })
  writeFileSync(join(out, 'results-sessions.json'), `${JSON.stringify(summary, null, 2)}\n`)
  writeFileSync(join(out, 'label-sheet.csv'), sheet)
  console.log(`Read ${summary.sessionsRead} sessions (${summary.filesRead} files, ${summary.badLines} broken lines skipped), ${summary.dateRange.from ?? '-'} to ${summary.dateRange.to ?? '-'}.`)
  printGroup('Your work', summary.main)
  printGroup('c-check itself (group "self", never in headline numbers)', summary.self)
  console.log(`\nWrote results-sessions.json and label-sheet.csv to the output folder.`)
}
