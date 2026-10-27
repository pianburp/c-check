// Reads Claude Code session files (<dir>/<project>/<session>.jsonl, plus <session>/subagents/*.jsonl) and yields
// their tool calls in order. Proof code only: the mod never imports it. Nothing here prints or saves content.
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'

export const DEFAULT_DIR = join(homedir(), '.claude', 'projects')

export interface ToolCall {
  sessionId: string
  /** Subagent id, for calls made inside a subagent. Its calls are numbered on their own. */
  agentId?: string
  /** The working folder of the session (its `cwd`), else the project folder name under dir. */
  project: string
  /** 1-based: the n-th tool call in this session file. */
  position: number
  toolUseId?: string
  timestamp?: string
  tool: string
  input: Record<string, unknown>
  /** The tool result said it failed. False when no result was recorded. */
  isError: boolean
}

export interface ReadStats {
  files: number
  /** Lines that were not valid JSON. They are skipped. */
  badLines: number
}

type Line = Record<string, any>

/** Yields every tool call under dir, file by file in sorted order. Unreadable files and broken lines are skipped and counted. */
export async function* readToolCalls(dir: string = DEFAULT_DIR, stats: ReadStats = { files: 0, badLines: 0 }): AsyncGenerator<ToolCall> {
  const files = (await readdir(dir, { recursive: true })).filter(f => f.endsWith('.jsonl')).sort()
  for (const rel of files) {
    let text: string
    try {
      text = await readFile(join(dir, rel), 'utf8')
    } catch {
      continue
    }
    stats.files++
    // shortcut: reads a whole session file at once (results come after their calls); fine for files up to a few hundred MB.
    const lines: Line[] = []
    for (const raw of text.split(/\r?\n/)) {
      if (raw.trim() === '') continue
      try {
        const line = JSON.parse(raw)
        if (typeof line === 'object' && line !== null) lines.push(line)
      } catch {
        stats.badLines++
      }
    }

    const failed = new Set<string>()
    for (const line of lines) {
      for (const part of contentOf(line)) if (part?.type === 'tool_result' && part.is_error === true) failed.add(part.tool_use_id)
    }

    const folder = rel.split(sep)[0] ?? ''
    const fallbackId = (rel.split(sep)[1] ?? rel).replace(/\.jsonl$/, '')
    let position = 0
    for (const line of lines) {
      if (line.type !== 'assistant') continue
      for (const part of contentOf(line)) {
        if (part?.type !== 'tool_use' || typeof part.name !== 'string') continue
        const id = typeof part.id === 'string' ? part.id : undefined
        yield {
          sessionId: typeof line.sessionId === 'string' ? line.sessionId : fallbackId,
          ...(typeof line.agentId === 'string' && { agentId: line.agentId }),
          project: typeof line.cwd === 'string' ? line.cwd : folder,
          position: ++position,
          ...(id !== undefined && { toolUseId: id }),
          ...(typeof line.timestamp === 'string' && { timestamp: line.timestamp }),
          tool: part.name,
          input: typeof part.input === 'object' && part.input !== null ? part.input : {},
          isError: id !== undefined && failed.has(id),
        }
      }
    }
  }
}

const contentOf = (line: Line): any[] => (Array.isArray(line.message?.content) ? line.message.content : [])
