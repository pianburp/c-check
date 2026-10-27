import { loadConfig } from '../config/config'
import type { Logger } from '../log/log'
import { relativeTo } from './paths'
import { filePathOf, isWriteTool, outputFailed } from './tools'
import { TimeoutError, type CheckEvent, type Ports, type Rule, type RuleMode, type SessionState, type Verdict, type VerdictKind } from './types'

export interface Outcome {
  kind: VerdictKind
  /** Text for Claude: block reasons, send-back reasons, or warnings. */
  message?: string
  /** Observe-mode rules whose own verdict was not allow. Claude is not told; the human should be. */
  seen?: string[]
}

export interface EngineDeps {
  rules: readonly Rule[]
  ports: Ports
  state: SessionState
  logger: Logger
}

export const gaveUpMessage = (tries: number): string => `c-check could not get this check to pass after ${tries} tries. A human should look at it.`

/** Runs every rule that listens on the event's point and returns the combined, mode-applied verdict. Never throws. */
export async function runEvent(event: CheckEvent, deps: EngineDeps): Promise<Outcome> {
  const { rules, ports, state, logger } = deps
  const { config, warnings } = await loadConfig(event.projectRoot, ports)
  const pending: Promise<void>[] = []
  const log = (line: Parameters<Logger['write']>[0]) => {
    pending.push(logger.write(line, config.logDir))
  }
  const notes: string[] = []

  for (const w of warnings) {
    if (state.warnedOnce.has(w)) continue
    state.warnedOnce.add(w)
    notes.push(w)
    log({ ts: event.timestamp, session: event.sessionId, event: 'config', details: { warning: w } })
  }

  if (event.point === 'after') recordChange(event, state)
  if (event.point === 'end') {
    state.endCache = undefined
    state.r1Passed = undefined
  }

  const active = rules.filter(r => r.points.includes(event.point))
  const seen: string[] = []
  const runRule = async (rule: Rule): Promise<Verdict | null> => {
      const ruleConfig = config.rules[rule.id] ?? { mode: rule.defaultMode }
      const mode: RuleMode = ruleConfig.mode ?? rule.defaultMode
      if (mode === 'off') return null

      const started = await ports.now()
      let verdict: Verdict
      let failure: string | undefined
      try {
        verdict = await rule.check(event, { config: ruleConfig, state, ports })
      } catch (err) {
        if (err instanceof TimeoutError) {
          verdict = { kind: 'warn', ruleId: rule.id, message: `c-check: ${rule.id} check timed out.`, details: { timeoutMs: err.timeoutMs } }
          failure = 'timeout'
        } else {
          verdict = { kind: 'allow', ruleId: rule.id, details: { error: String((err as Error)?.message ?? err) } }
          failure = 'error'
        }
      }
      // Advisory rules (the LLM judge) can only warn.
      if (rule.advisory === true && (verdict.kind === 'block' || verdict.kind === 'send_back')) verdict = { ...verdict, kind: 'warn' }
      if (verdict.kind === 'send_back' && event.point !== 'end') verdict = { ...verdict, kind: 'block' }

      // A timeout or crash is not a finding, so it does not count as seen.
      if (mode === 'observe' && verdict.kind !== 'allow' && failure === undefined) seen.push(rule.id)
      let final: Verdict = mode === 'observe' ? { kind: 'allow', ruleId: rule.id } : verdict
      let gaveUp = false
      if (mode === 'enforce') {
        if (final.kind === 'send_back') {
          const n = state.sendBacks.get(rule.id) ?? 0
          if (n >= config.maxSendBacks) {
            final = { kind: 'warn', ruleId: rule.id, message: gaveUpMessage(config.maxSendBacks) }
            gaveUp = true
          } else {
            state.sendBacks.set(rule.id, n + 1)
          }
        } else if (event.point === 'end' && verdict.kind === 'allow' && failure === undefined) {
          state.sendBacks.delete(rule.id)
        }
      }

      const ms = (await ports.now()) - started
      log({
        ts: event.timestamp,
        session: event.sessionId,
        point: event.point,
        ...(event.tool !== undefined && { tool: event.tool }),
        ...(event.toolUseId !== undefined && { toolUseId: event.toolUseId }),
        rule: rule.id,
        mode,
        verdict: verdict.kind,
        applied: final.kind,
        ms,
        ...(failure !== undefined && { event: failure }),
        ...(verdict.details !== undefined && { details: verdict.details }),
      })
      if (gaveUp) log({ ts: event.timestamp, session: event.sessionId, point: event.point, rule: rule.id, mode, event: 'gave_up' })
      return final
  }
  // Advisory rules go last: the judge needs to know whether the other end rules (tests) passed.
  const applied = [
    ...(await Promise.all(active.filter(r => r.advisory !== true).map(runRule))),
    ...(await Promise.all(active.filter(r => r.advisory === true).map(runRule))),
  ]

  await Promise.all(pending)
  const outcome = combine(applied.filter((v): v is Verdict => v !== null), notes)
  return seen.length > 0 ? { ...outcome, seen: seen.sort() } : outcome
}

/** §6.1: any block wins, else any send_back, else warn, else allow. Messages of the winning kind are joined. */
export function combine(verdicts: readonly Verdict[], notes: readonly string[] = []): Outcome {
  const pick = (kind: VerdictKind) => verdicts.filter(v => v.kind === kind)
  const text = (vs: readonly Verdict[]) => vs.map(v => `[c-check: ${v.ruleId}] ${v.message ?? ''}`.trim())
  for (const kind of ['block', 'send_back'] as const) {
    const hits = pick(kind)
    if (hits.length > 0) return { kind, message: [...text(hits), ...notes].join('\n\n') }
  }
  const warns = [...text(pick('warn')), ...notes]
  return warns.length > 0 ? { kind: 'warn', message: warns.join('\n\n') } : { kind: 'allow' }
}

function recordChange(event: CheckEvent, state: SessionState): void {
  if (!isWriteTool(event.tool) || outputFailed(event.output)) return
  const file = filePathOf(event.input)
  if (file === undefined) return
  const rel = relativeTo(event.projectRoot, file)
  if (rel !== null) state.changedFiles.add(rel)
}
