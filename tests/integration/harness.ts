// Full-chain test harness: recorded mod payload -> real adapter (src/adapter/register.ts) -> engine -> rules -> mod response.
// The mods API ($) is backed by real Node: real files, real git, real test commands in a temp repo.
// `claude plugin test` cannot do this: its sandbox has no real process or file access.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { register } from '../../src/adapter/register'

const PAYLOADS = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'payloads')

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<any>) => Promise<any>

export interface Repo {
  root: string
  /** Mod response for each event. */
  start(): Promise<void>
  /** Returns the prompt event as passed on, so tests can read the context c-check added. */
  prompt(text: string): Promise<any>
  turnComplete(): Promise<any>
  tool(name: string, args: Record<string, unknown>, opts?: { result?: Record<string, unknown> }): Promise<any>
  stop(extra?: Record<string, unknown>): Promise<any>
  write(rel: string, text: string): void
  read(rel: string): string
  rm(rel: string): void
  commit(): Promise<void>
  logs(): Array<Record<string, any>>
  /** Log lines for one rule. */
  lines(rule: string): Array<Record<string, any>>
  cleanup(): void
}

function run(argv: string[], cwd: string, env?: Record<string, string>, timeoutMs = 30_000): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(argv[0] as string, argv.slice(1), { cwd, env: { ...process.env, ...env }, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err && (err as { killed?: boolean }).killed) return reject(new Error('still running at timeout'))
      if (err && typeof (err as { code?: unknown }).code !== 'number') return reject(err)
      resolve({ exitCode: err ? ((err as { code: number }).code ?? 1) : 0, stdout, stderr })
    })
  })
}

function nodeEngine(root: string, sessionId: string) {
  const abs = (p: string) => (/^([A-Za-z]:)?[\\/]/.test(p) ? p : join(root, p))
  return {
    clock: { now: async () => Date.now() },
    process: { run: (argv: string[], init?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => run(argv, abs(init?.cwd ?? root), init?.env, init?.timeoutMs) },
    fs: {
      exists: async (p: string) => existsSync(abs(p)),
      read: async (p: string) => readFileSync(abs(p), 'utf8'),
      write: async (p: string, text: string) => {
        mkdirSync(dirname(abs(p)), { recursive: true })
        writeFileSync(abs(p), text)
      },
      stat: async (p: string, o?: { resolve: boolean }) => {
        const s = statSync(abs(p))
        let realPath: string | undefined
        try {
          realPath = o?.resolve ? realpathSync.native(abs(p)) : undefined
        } catch {
          realPath = undefined
        }
        return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink: false, ...(realPath !== undefined && { realPath }) }
      },
    },
    session: { id: async () => sessionId, root: async () => root },
  }
}

/** Loads a recorded payload, with the recording session's project path swapped for `root`. */
export function payload(name: string, root: string): Record<string, unknown> {
  const text = readFileSync(join(PAYLOADS, `${name}.json`), 'utf8')
  return JSON.parse(text.replaceAll('{{ROOT}}', JSON.stringify(root).slice(1, -1)))
}

const git = (root: string, ...args: string[]) => run(['git', '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], root)

let counter = 0

export async function makeRepo(files: Record<string, string> = {}, opts: { git?: boolean; config?: unknown } = {}): Promise<Repo> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'c-check-')))
  const sessionId = `test-session-${++counter}-${Date.now()}`
  const allFiles = { ...files, ...(opts.config !== undefined && { 'c-check.config.json': JSON.stringify(opts.config) }) }
  for (const [rel, text] of Object.entries(allFiles)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  if (opts.git !== false) {
    await git(root, 'init', '-q')
    await git(root, 'config', 'core.autocrlf', 'false')
    await git(root, 'add', '-A')
    await git(root, 'commit', '-qm', 'init', '--allow-empty')
  }

  // Each register() call is a fresh mod load with its own session, as Claude Code gives one per session.
  const hooks = new Map<string, Hook>()
  register(((name: string, a: unknown, b?: unknown) => {
    hooks.set(name, (b ?? a) as Hook)
    return { catch: () => undefined }
  }) as never)
  const $ = nodeEngine(root, sessionId)
  const fire = (name: string, e: unknown, next: (e: unknown) => Promise<any>) => {
    const hook = hooks.get(name)
    if (hook === undefined) throw new Error(`no hook for ${name}`)
    return hook($, Object.freeze(e), next)
  }

  const abs = (p: string) => (/^([A-Za-z]:)?[\\/]/.test(p) ? p : join(root, p))
  /** Claude Code's own behavior for the tools tests use: it really changes the file. */
  const core = async (e: any): Promise<any> => {
    if (e.tool === 'Write') {
      mkdirSync(dirname(abs(e.file_path)), { recursive: true })
      writeFileSync(abs(e.file_path), e.content)
      return { ref: 1, result: { type: 'create', filePath: e.file_path }, text: `File created successfully at: ${e.file_path}` }
    }
    if (e.tool === 'Edit') {
      const before = readFileSync(abs(e.file_path), 'utf8')
      if (!before.includes(e.old_string)) return { ref: 1, result: 'String to replace not found', text: 'String to replace not found', isError: true }
      writeFileSync(abs(e.file_path), e.replace_all ? before.replaceAll(e.old_string, e.new_string) : before.replace(e.old_string, e.new_string))
      return { ref: 1, result: { filePath: e.file_path }, text: `The file ${e.file_path} has been updated successfully.` }
    }
    return { ref: 1, result: { stdout: '', stderr: '' }, text: '' }
  }

  const repo: Repo = {
    root,
    async start() {
      await fire('session.start', payload('session.start', root), async e => e)
    },
    async prompt(text) {
      let passed: unknown
      await fire('prompt.submit', { ...payload('prompt.submit', root), text }, async e => {
        passed = e
        return {}
      })
      return passed
    },
    async turnComplete() {
      return fire('turn.complete', { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }, async () => ({}))
    },
    async tool(name, args, opts) {
      const base = ['Write', 'Edit', 'Bash'].includes(name) ? payload(`tool.call-${name}`, root) : { tool: name, tool_use_id: 'toolu_test' }
      // Recorded payload shape, with this case's arguments in place of the recorded ones.
      const keep = Object.fromEntries(Object.entries(base).filter(([k]) => k === 'tool' || k === 'tool_use_id'))
      return fire('tool.call', { ...keep, tool: name, ...args }, async e => (opts?.result !== undefined ? opts.result : core(e)))
    },
    async stop(extra) {
      return fire('classic.Stop', { ...payload('classic.Stop', root), session_id: sessionId, ...extra }, async () => ({}))
    },
    write(rel, text) {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    },
    read: rel => readFileSync(join(root, rel), 'utf8'),
    rm: rel => rmSync(join(root, rel), { recursive: true, force: true }),
    async commit() {
      await git(root, 'add', '-A')
      await git(root, 'commit', '-qm', 'step')
    },
    logs() {
      const dir = join(root, '.c-check', 'logs')
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .flatMap(f => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
    },
    lines: rule => repo.logs().filter(l => l.rule === rule),
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 })
      } catch {
        // On Windows a timed-out test command can leave a child process holding the folder; the OS temp cleanup takes it later.
      }
    },
  }
  return repo
}

/** A package.json whose test script passes or fails on purpose, run through a plain `node` command for speed. */
export const testScript = (pass: boolean) => `node -e "process.exit(${pass ? 0 : 1})"`
