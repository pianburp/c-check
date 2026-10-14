// The only file that knows the mods API. It turns mod events into CheckEvents and Outcomes back into mod results.
// Every handler fails open: if c-check breaks, Claude Code carries on as if c-check were not installed.
import type { EngineInterface, On } from 'claude-code'

import { runEvent, type Outcome } from '../engine/engine'
import { newSessionState, TimeoutError, type CheckPoint, type Ports, type SessionState } from '../engine/types'
import { Logger } from '../log/log'
import { RULES } from '../rules/index'
import { snapshot } from '../rules/git'

interface Session {
  state: SessionState
  logger: Logger
}

/** One per loaded mod: a mod instance serves one Claude Code session. */
interface Box {
  session?: Session
  /** End-of-task warnings not yet shown. At Stop, text handed to Claude makes it keep working, so they wait for the next prompt. */
  pending: string[]
}

// Fields of a tool.call event that are not the tool's own arguments.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'agentId'])
const PARAGRAPH = '\n\n'

/** File and process access for the engine, bound to this hook's `$`. */
function portsOf($: EngineInterface): Ports {
  return {
    run: async (argv, opts) => {
      const started = await $.clock.now()
      try {
        return await $.process.run(argv, {
          cwd: opts.cwd,
          ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
          ...(opts.env !== undefined && { env: opts.env }),
        })
      } catch (err) {
        // process.run rejects without saying why; a rejection at the deadline is the timeout.
        if (opts.timeoutMs !== undefined && (await $.clock.now()) - started >= opts.timeoutMs - 100) throw new TimeoutError(opts.timeoutMs)
        throw err
      }
    },
    read: async path => ((await $.fs.exists(path)) ? String(await $.fs.read(path)) : null),
    write: (path, text) => $.fs.write(path, text),
    realPath: async path => {
      try {
        return (await $.fs.stat(path, { resolve: true })).realPath
      } catch {
        return undefined
      }
    },
    now: () => $.clock.now(),
  }
}

async function startSession($: EngineInterface, box: Box, cwd: string | undefined): Promise<Session> {
  const id = await $.session.id()
  const root = cwd ?? (await $.session.root())
  const ports = portsOf($)
  const state = newSessionState(id, root)
  const current: Session = { state, logger: new Logger(ports, root, id) }
  box.session = current
  try {
    state.baseline = await snapshot(ports, root, id)
  } catch (err) {
    state.baseline = undefined
    void current.logger.write({ ts: new Date(await $.clock.now()).toISOString(), session: id, event: 'error', details: { baseline: String((err as Error)?.message ?? err) } }, '.c-check/logs')
  }
  return current
}

async function sessionOf($: EngineInterface, box: Box): Promise<Session> {
  return box.session ?? startSession($, box, undefined)
}

async function check($: EngineInterface, box: Box, point: CheckPoint, tool?: string, input?: Record<string, unknown>, output?: unknown): Promise<Outcome> {
  try {
    const s = await sessionOf($, box)
    const event = {
      point,
      sessionId: s.state.id,
      projectRoot: s.state.root,
      ...(tool !== undefined && { tool }),
      ...(input !== undefined && { input }),
      ...(output !== undefined && { output }),
      timestamp: new Date(await $.clock.now()).toISOString(),
    }
    return await runEvent(event, { rules: RULES, ports: portsOf($), state: s.state, logger: s.logger })
  } catch {
    return { kind: 'allow' }
  }
}

async function logUnknown($: EngineInterface, box: Box, what: string): Promise<void> {
  try {
    const s = await sessionOf($, box)
    await s.logger.write({ ts: new Date(await $.clock.now()).toISOString(), session: s.state.id, event: 'unknown_event', details: { what } }, '.c-check/logs')
  } catch {}
}

export function register(on: On): void {
  const box: Box = { pending: [] }

  on('session.start', async ($, e, next) => {
    try {
      await startSession($, box, typeof e.cwd === 'string' ? e.cwd : undefined)
    } catch {}
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      if (typeof e.text === 'string') (await sessionOf($, box)).state.prompts.push(e.text)
    } catch {}
    if (box.pending.length === 0) return next(e)
    const notes = box.pending.splice(0)
    return next({ ...e, context: [...(e.context ?? []), ['c-check warnings from the end of your last task:', ...notes].join(PARAGRAPH)] })
  }).catch(async ($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const raw = e as unknown as Readonly<Record<string, unknown>>
    if (typeof raw.tool !== 'string') {
      await logUnknown($, box, 'tool.call without tool')
      return next(e)
    }
    const tool = raw.tool
    const input = Object.fromEntries(Object.entries(raw).filter(([k]) => !ENVELOPE.has(k)))

    const before = await check($, box, 'before', tool, input)
    if (before.kind === 'block') return { deny: before.message ?? 'Blocked by c-check.' }

    const result = await next(e)
    // Refused further down the chain: the tool never ran, so there is nothing to inspect.
    if (result.deny !== undefined) return result

    const after = await check($, box, 'after', tool, input, { isError: result.isError === true, text: result.text })
    if (after.kind === 'block') return { deny: after.message ?? 'Blocked by c-check.' }
    const notes = [before, after].flatMap(o => (o.kind === 'warn' && o.message !== undefined ? [o.message] : []))
    return notes.length > 0 ? { ...result, context: [...(result.context ?? []), ...notes] } : result
  }).catch(async ($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const end = await check($, box, 'end')
    if (end.kind === 'send_back' || end.kind === 'block') return { block: end.message ?? 'c-check: an end check failed.' }
    if (end.kind === 'warn' && end.message !== undefined) box.pending.push(end.message)
    return next(e)
  }).catch(async ($, e, next) => next(e))

  // The user sees end-of-task warnings under the answer; Claude gets them with the next prompt.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined || box.pending.length === 0) return next(e)
    return { text: box.pending.join(PARAGRAPH) }
  })
}
