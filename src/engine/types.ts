// Data shapes from the design (§6). Nothing here depends on the mods API.

export type CheckPoint = 'before' | 'after' | 'end'

export interface CheckEvent {
  point: CheckPoint
  sessionId: string
  projectRoot: string // absolute path
  tool?: string // e.g. "Edit", "Write", "Bash", "Read"
  input?: Record<string, unknown> // tool input
  output?: unknown // tool result (after only)
  timestamp: string // ISO 8601
}

export type VerdictKind = 'allow' | 'warn' | 'block' | 'send_back'

export interface Verdict {
  kind: VerdictKind
  ruleId: string
  message?: string // shown to Claude. Say what failed AND what to do instead.
  details?: unknown // for the log only
}

export type RuleMode = 'off' | 'observe' | 'enforce'

export type RuleConfig = { mode?: RuleMode } & Record<string, unknown>

export interface Rule {
  id: string // e.g. "no-outside-edits"
  description: string
  points: CheckPoint[] // where this rule runs
  defaultMode: RuleMode
  check(event: CheckEvent, ctx: RuleContext): Promise<Verdict>
}

export interface RuleContext {
  config: RuleConfig // this rule's settings from c-check.config.json
  state: SessionState // per-session memory (e.g. files changed so far)
  ports: Ports // file and process access, supplied by the adapter
}

export interface RunResult {
  exitCode: number
  stdout: string
  stderr: string
}

/** What the engine and rules may do to the outside world. The adapter builds it from the mods API. */
export interface Ports {
  /** Runs argv without a shell. Rejects with TimeoutError when it runs past timeoutMs. */
  run(argv: string[], opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> }): Promise<RunResult>
  /** File text, or null when the file does not exist. */
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
  /** Absolute path with every symlink followed, or undefined when the path does not exist. */
  realPath(path: string): Promise<string | undefined>
  now(): Promise<number>
}

export class TimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms`)
    this.timeoutMs = timeoutMs
  }
}

export interface Snapshot {
  /** git tree hash of the whole working tree, untracked files included. */
  tree: string
}

export interface SessionState {
  id: string
  root: string
  /** Working tree at session start; null when the project is not a git repo. */
  baseline: Snapshot | null | undefined
  /** Project-relative paths Claude changed with file tools (from after-events). */
  changedFiles: Set<string>
  /** Send-backs per rule since that rule last passed. */
  sendBacks: Map<string, number>
  /** User prompts this session. Kept in memory only, never logged. */
  prompts: string[]
  /** Tree hash at the last passing test run, so unchanged code is not re-tested. */
  lastGreenTree?: string
  /** Messages already shown once (config warnings). */
  warnedOnce: Set<string>
  /** Per end-event cache of the session diff, shared by end rules. */
  endCache?: Promise<unknown>
}

export function newSessionState(id: string, root: string): SessionState {
  return { id, root, baseline: undefined, changedFiles: new Set(), sendBacks: new Map(), prompts: [], warnedOnce: new Set() }
}
