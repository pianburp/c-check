import type { Ports } from '../engine/types'

export interface LogLine {
  ts: string
  session: string
  point?: string
  tool?: string
  /** Links the line to its tool call in the session transcript. Not on end lines. */
  toolUseId?: string
  rule?: string
  mode?: string
  verdict?: string
  applied?: string
  ms?: number
  /** Set for lines that are not a plain check: "gave_up", "error", "timeout", "config", "unknown_event". */
  event?: string
  /** Line numbers, file names, counts. Never file contents or secret values. */
  details?: unknown
}

/**
 * Appends JSON Lines to <root>/<logDir>/<date>-<session>.jsonl.
 * One file per session: the mods fs API has no append, so each session keeps its own lines and rewrites its own file.
 * shortcut: rewrites the whole session file per line, fine up to the 4 MiB fs limit (~20k lines); upgrade to $.fs append if the API gains one.
 */
export class Logger {
  private lines: string[] = []
  private file: string | undefined
  private queue: Promise<void> = Promise.resolve()

  private readonly ports: Ports
  private readonly root: string
  private readonly sessionId: string

  constructor(ports: Ports, root: string, sessionId: string) {
    this.ports = ports
    this.root = root
    this.sessionId = sessionId
  }

  write(line: LogLine, logDir: string): Promise<void> {
    this.file ??= `${this.root}/${logDir}/${line.ts.slice(0, 10)}-${this.sessionId.slice(0, 8)}.jsonl`
    this.lines.push(JSON.stringify(line))
    const file = this.file
    // Writes are chained so two events never interleave a rewrite.
    this.queue = this.queue.then(() => this.ports.write(file, `${this.lines.join('\n')}\n`)).catch(() => {})
    return this.queue
  }
}
