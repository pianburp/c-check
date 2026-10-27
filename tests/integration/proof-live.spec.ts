import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const LIVE = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../proof/live-report.ts')

// Content the fake logs carry in details, as real lines do. None of it may reach the outputs.
const PRIVATE = ['src/payment.js', 'C:\\elsewhere\\notes.txt', 'npm test -- --coverage', 'removed 2 test cases in tests/cart.test.js', '/dashboard', 'support@shop.example']

const line = (o: Record<string, unknown>) => JSON.stringify(o)
const SHOP = [
  line({ ts: '2026-10-01T09:00:00.000Z', session: 'sess-a', event: 'baseline', details: { tree: 'abc123' } }),
  line({ ts: '2026-10-01T09:00:01.000Z', session: 'sess-a', point: 'before', tool: 'Bash', toolUseId: 'toolu_l1', rule: 'no-risky-commands', mode: 'observe', verdict: 'block', applied: 'allow', ms: 2, details: { pattern: 'git push --force' } }),
  line({ ts: '2026-10-01T09:00:01.000Z', session: 'sess-a', point: 'before', tool: 'Bash', toolUseId: 'toolu_l1', rule: 'no-outside-edits', mode: 'observe', verdict: 'allow', applied: 'allow', ms: 4 }),
  line({ ts: '2026-10-01T09:00:02.000Z', session: 'sess-a', point: 'before', tool: 'Write', toolUseId: 'toolu_l2', rule: 'no-outside-edits', mode: 'observe', verdict: 'block', applied: 'allow', ms: 6, details: { target: 'C:\\elsewhere\\notes.txt' } }),
  line({ ts: '2026-10-01T09:00:03.000Z', session: 'sess-a', point: 'after', tool: 'Write', toolUseId: 'toolu_l3', rule: 'no-secrets-in-files', mode: 'observe', verdict: 'warn', applied: 'allow', ms: 1, details: { file: 'src/payment.js', lines: [3], patterns: ['password literal'] } }),
  '{"ts":"2026-10-01T09:00:04.000Z","session":"sess-a","rule":"torn',
  line({ ts: '2026-10-01T09:05:00.000Z', session: 'sess-a', point: 'end', rule: 'tests-pass-before-done', mode: 'observe', verdict: 'send_back', applied: 'allow', ms: 4000, details: { command: 'npm test -- --coverage', exitCode: 1 } }),
  line({ ts: '2026-10-01T09:05:00.000Z', session: 'sess-a', point: 'end', rule: 'no-test-weakening', mode: 'observe', verdict: 'send_back', applied: 'allow', ms: 30, details: { findings: ['removed 2 test cases in tests/cart.test.js'] } }),
  line({ ts: '2026-10-01T09:05:00.000Z', session: 'sess-a', point: 'end', rule: 'no-data-before-login', mode: 'observe', verdict: 'send_back', applied: 'allow', ms: 900, details: { routes: [{ route: '/dashboard', status: 200, detectors: ['email address'], bodyChars: 80, scripts: 0 }] } }),
  line({ ts: '2026-10-01T09:05:00.000Z', session: 'sess-a', point: 'end', rule: 'tests-still-bite', mode: 'observe', verdict: 'allow', applied: 'allow', ms: 2000, event: 'timeout', details: { command: 'npm test -- --coverage' } }),
].join('\n')
const BLOG = [
  line({ ts: '2026-10-09T18:00:00.000Z', session: 'sess-b', point: 'before', tool: 'Bash', toolUseId: 'toolu_l9', rule: 'deploy-gate', mode: 'observe', verdict: 'block', applied: 'allow', ms: 8, details: { pattern: 'vercel --prod' } }),
  line({ ts: '2026-10-09T18:01:00.000Z', session: 'sess-b', point: 'end', rule: 'claimed-changes-are-real', mode: 'observe', verdict: 'allow', applied: 'allow', ms: 20, details: { noEffect: [], unreported: ['support@shop.example'] } }),
].join('\n')
const SELF = line({ ts: '2026-10-10T08:00:00.000Z', session: 'sess-c', point: 'before', tool: 'Bash', toolUseId: 'toolu_s1', rule: 'no-risky-commands', mode: 'observe', verdict: 'block', applied: 'allow', ms: 1, details: { pattern: 'git reset --hard' } })

let root: string
let out: string
let stdout: string
let results: any
let sheet: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'c-check-live-'))
  out = join(root, 'out')
  const project = (name: string, text: string, logDir?: string) => {
    const dir = join(root, name)
    mkdirSync(join(dir, logDir ?? '.c-check/logs'), { recursive: true })
    if (logDir !== undefined) writeFileSync(join(dir, 'c-check.config.json'), JSON.stringify({ logDir }))
    writeFileSync(join(dir, logDir ?? '.c-check/logs', '2026-10-01-sess.jsonl'), `${text}\n`)
    return dir
  }
  const args = [project('shop', SHOP), project('blog', BLOG, 'logs/c-check'), project('c-check', SELF), join(root, 'no-logs-here')]
  stdout = execFileSync(process.execPath, [LIVE, ...args, '--self', join(root, 'c-check'), '--out', out], { encoding: 'utf8' })
  results = JSON.parse(readFileSync(join(out, 'results-live.json'), 'utf8'))
  sheet = readFileSync(join(out, 'label-live.csv'), 'utf8')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('proof: live log report', () => {
  test('fires for all rules, end rules included, with pattern and detector names', () => {
    expect(results.main.fires).toEqual({
      'no-risky-commands': { total: 1, byPattern: { 'git push --force': 1 } },
      'no-outside-edits': { total: 1, byPattern: { '-': 1 } },
      'no-secrets-in-files': { total: 1, byPattern: { 'password literal': 1 } },
      'tests-pass-before-done': { total: 1, byPattern: { '-': 1 } },
      'no-test-weakening': { total: 1, byPattern: { '-': 1 } },
      'no-data-before-login': { total: 1, byPattern: { 'email address': 1 } },
      'deploy-gate': { total: 1, byPattern: { 'vercel --prod': 1 } },
    })
    expect(results.main.errors).toEqual({ 'tests-still-bite': 1 })
    expect(results.main).toMatchObject({ projects: 2, sessions: 2, checks: 10 })
    expect(results.dateRange).toEqual({ from: '2026-10-01T09:00:01.000Z', to: '2026-10-10T08:00:00.000Z' })
  })

  test('time cost per point: median and slowest ms over every check', () => {
    expect(results.main.time).toEqual({
      after: { checks: 1, medianMs: 1, slowestMs: 1 },
      before: { checks: 4, medianMs: 5, slowestMs: 8 },
      // 20, 30, 900, 2000 (the timed-out check), 4000.
      end: { checks: 5, medianMs: 900, slowestMs: 4000 },
    })
    expect(stdout).toContain('time at end: median 900 ms, slowest 4000 ms over 5 checks')
  })

  test('group "self" is apart, and the label sheet has the Phase 3 shape', () => {
    expect(results.self).toMatchObject({ projects: 1, sessions: 1, checks: 1, fires: { 'no-risky-commands': { total: 1 } } })
    const rows = sheet.trim().split('\n')
    expect(rows[0]).toBe('session_id,agent_id,group,timestamp,position,tool_use_id,rule,pattern,label')
    expect(rows).toHaveLength(1 + 7 + 1)
    expect(rows).toContain('sess-a,,main,2026-10-01T09:00:01.000Z,,toolu_l1,no-risky-commands,git push --force,')
    expect(rows).toContain('sess-a,,main,2026-10-01T09:05:00.000Z,,,no-test-weakening,-,')
    expect(rows).toContain('sess-c,,self,2026-10-10T08:00:00.000Z,,toolu_s1,no-risky-commands,git reset --hard,')
  })

  test('privacy: no paths, commands, findings or routes from the logs reach any output', () => {
    const outputs = [stdout, readFileSync(join(out, 'results-live.json'), 'utf8'), sheet]
    for (const s of [...PRIVATE, 'abc123', root, JSON.stringify(root).slice(1, -1)]) for (const text of outputs) expect(text.includes(s), `leaked: ${s.slice(0, 20)}`).toBe(false)
  })
})
