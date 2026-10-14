// Edge cases an integration test cannot reach reliably (§12.2): a rule that throws, a rule that times out.
import { describe, expect, test } from 'vitest'
import { runEvent } from '../../src/engine/engine'
import { newSessionState, TimeoutError, type CheckEvent, type Ports, type Rule } from '../../src/engine/types'
import { Logger } from '../../src/log/log'

function memoryPorts(files: Record<string, string> = {}): Ports & { files: Record<string, string> } {
  return {
    files,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    read: async p => files[p] ?? null,
    write: async (p, t) => {
      files[p] = t
    },
    realPath: async p => p,
    now: async () => 0,
  }
}

const rule = (id: string, check: Rule['check'], points: Rule['points'] = ['before']): Rule => ({ id, description: id, points, defaultMode: 'enforce', check })
const event: CheckEvent = { point: 'before', sessionId: 's1', projectRoot: '/p', tool: 'Bash', input: { command: 'ls' }, timestamp: '2026-10-11T10:00:00Z' }

async function run(rules: Rule[]) {
  const ports = memoryPorts()
  const state = newSessionState('s1', '/p')
  const outcome = await runEvent(event, { rules, ports, state, logger: new Logger(ports, '/p', 's1') })
  const log = Object.values(ports.files).join('').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return { outcome, log }
}

describe('engine failure safety', () => {
  test('a rule that throws is treated as allow and logged', async () => {
    const { outcome, log } = await run([
      rule('boom', async () => {
        throw new Error('kaboom')
      }),
    ])
    expect(outcome).toEqual({ kind: 'allow' })
    expect(log).toEqual([expect.objectContaining({ rule: 'boom', verdict: 'allow', applied: 'allow', event: 'error', details: { error: 'kaboom' } })])
  })

  test('a throwing rule does not hide a block from another rule', async () => {
    const { outcome } = await run([
      rule('boom', async () => {
        throw new Error('x')
      }),
      rule('blocker', async () => ({ kind: 'block', ruleId: 'blocker', message: 'no' })),
    ])
    expect(outcome).toEqual({ kind: 'block', message: '[c-check: blocker] no' })
  })

  test('a check past its time limit becomes warn "check timed out"', async () => {
    const { outcome, log } = await run([
      rule('slow', async () => {
        throw new TimeoutError(200)
      }),
    ])
    expect(outcome).toEqual({ kind: 'warn', message: '[c-check: slow] c-check: slow check timed out.' })
    expect(log[0]).toMatchObject({ rule: 'slow', verdict: 'warn', event: 'timeout', details: { timeoutMs: 200 } })
  })

  test('block messages are all returned together', async () => {
    const { outcome } = await run([
      rule('a', async () => ({ kind: 'block', ruleId: 'a', message: 'one' })),
      rule('b', async () => ({ kind: 'block', ruleId: 'b', message: 'two' })),
      rule('c', async () => ({ kind: 'warn', ruleId: 'c', message: 'three' })),
    ])
    expect(outcome).toEqual({ kind: 'block', message: '[c-check: a] one\n\n[c-check: b] two' })
  })
})
