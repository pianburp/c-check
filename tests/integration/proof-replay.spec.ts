import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const PROOF = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../proof')
const FIXTURES = join(PROOF, 'fixtures/projects')
const SELF = 'C:\\dev\\c-check'

let out: string
let stdout: string
let results: any
let sheet: string
let rows: Array<Record<string, string>>

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'c-check-proof-'))
  stdout = execFileSync(process.execPath, [join(PROOF, 'replay-sessions.ts'), FIXTURES, '--self', SELF, '--out', out], { encoding: 'utf8' })
  results = JSON.parse(readFileSync(join(out, 'results-sessions.json'), 'utf8'))
  sheet = readFileSync(join(out, 'label-sheet.csv'), 'utf8')
  const [head, ...body] = sheet.trim().split('\n')
  const cols = (head as string).split(',')
  rows = body.map(l => Object.fromEntries(l.split(',').map((v, i) => [cols[i] as string, v])))
})
afterAll(() => rmSync(out, { recursive: true, force: true }))

const firesOf = (session: string) => rows.filter(r => r.session_id?.startsWith(session)).map(r => [r.rule, r.pattern])

describe('proof: replay old sessions through the CLI', () => {
  test('each fixture gives the expected fires', () => {
    expect(firesOf('a1111111')).toEqual([['no-risky-commands', 'git push --force']])
    expect(firesOf('a2222222')).toEqual([['no-secrets-in-files', 'password literal']])
    // deploy-gate: a count of deploy commands only, never a fire.
    expect(firesOf('b3333333')).toEqual([])
    expect(results.main.deployCommandsSeen).toEqual({ total: 1, byPattern: { 'vercel --prod': 1 } })
    expect(results.main.fires).toEqual({
      'no-risky-commands': { total: 1, byPattern: { 'git push --force': 1 } },
      'no-secrets-in-files': { total: 1, byPattern: { 'password literal': 1 } },
    })
  })

  test('the clean session gives zero fires', () => {
    expect(firesOf('b4444444')).toEqual([])
  })

  test('group "self" is reported apart and kept out of the main numbers', () => {
    expect(results.self).toMatchObject({ sessions: 1, toolCalls: 1, fires: { 'no-risky-commands': { total: 1, byPattern: { 'git reset --hard': 1 } } } })
    expect(results.main).toMatchObject({ sessions: 4, toolCalls: 8 })
    expect(rows.find(r => r.session_id?.startsWith('c5555555'))?.group).toBe('self')
    expect(rows.filter(r => r.group === 'main')).toHaveLength(2)
  })

  test('sessions read, date range, broken lines and label sheet columns', () => {
    expect(results).toMatchObject({ sessionsRead: 5, filesRead: 6, badLines: 1, dateRange: { from: '2026-09-01T10:00:05.000Z', to: '2026-09-05T12:00:04.000Z' } })
    expect(sheet.split('\n')[0]).toBe('session_id,agent_id,group,timestamp,position,tool_use_id,rule,pattern,label')
    expect(rows.find(r => r.tool_use_id === 'toolu_fake_risky_2')).toMatchObject({ position: '2', timestamp: '2026-09-01T10:00:10.000Z', label: '' })
  })

  test('privacy: no fixture content reaches stdout, results or the label sheet', () => {
    // Every string value in the fixtures except the ids, timestamps and names the proof is allowed to keep.
    const allowed = /^(?:[0-9a-f-]{36}|toolu_[\w]+|\d{4}-\d\d-\d\dT[\d:.]+Z|[\w.-]{1,12}|true|false)$/
    const secrets = new Set<string>()
    const collect = (v: unknown): void => {
      if (typeof v === 'string') {
        if (!allowed.test(v)) secrets.add(v)
      } else if (Array.isArray(v)) v.forEach(collect)
      else if (typeof v === 'object' && v !== null) Object.values(v).forEach(collect)
    }
    const files = readdirSync(FIXTURES, { recursive: true }).filter(f => String(f).endsWith('.jsonl'))
    for (const f of files) {
      for (const line of readFileSync(join(FIXTURES, String(f)), 'utf8').split('\n')) {
        try {
          collect(JSON.parse(line))
        } catch {}
      }
    }
    // The ones that matter most, named so a too-loose filter above cannot hide them (the fake key is short enough to pass it).
    for (const must of ['git push --force origin main', 'npm run build && vercel --prod', 'q8Zr2LmW4vNt', 'C:\\work\\shop\\src\\payment.js', 'C:\\work\\shop', 'push my branch']) secrets.add(must)
    const outputs = [stdout, readFileSync(join(out, 'results-sessions.json'), 'utf8'), sheet]
    for (const s of secrets) for (const text of outputs) expect(text.includes(s), `leaked: ${s.slice(0, 20)}`).toBe(false)
    // JSON escapes backslashes: check the escaped spelling of paths too.
    expect(outputs[1]).not.toContain('work\\\\shop')
  })
})
