import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { RULES } from '../../src/rules/index'
import { makeRepo, payload, type Repo } from './harness'

// The config the proof plan hands out for observe-mode logging in other projects.
const OBSERVE = JSON.parse(readFileSync(join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../proof/observe-config.json'), 'utf8'))
const repos: Repo[] = []
afterAll(() => repos.forEach(r => r.cleanup()))

describe('proof: observe-mode log', () => {
  test('a fire writes one full log line and the tool call still runs', async () => {
    const r = await makeRepo({ 'a.txt': 'a\n' }, { config: OBSERVE })
    repos.push(r)
    await r.start()
    const ran = { ref: 1, result: { stdout: '', stderr: '' }, text: 'ran' }
    const res = await r.tool('Bash', { command: 'git push --force origin main', description: 'x' }, { result: ran })
    expect(res).toEqual(ran)

    const id = payload('tool.call-Bash', r.root).tool_use_id
    const fires = r.lines('no-risky-commands').filter(l => l.verdict !== 'allow')
    expect(fires).toHaveLength(1)
    expect(fires[0]).toMatchObject({ session: expect.any(String), point: 'before', tool: 'Bash', toolUseId: id, mode: 'observe', verdict: 'block', applied: 'allow', ms: expect.any(Number) })
    expect(Number.isNaN(Date.parse(fires[0]?.ts))).toBe(false)
    // Allows carry ms too, so time cost is measured on every check, not only on fires.
    const checks = r.logs().filter(l => l.rule !== undefined)
    expect(checks.every(l => typeof l.ms === 'number')).toBe(true)
    expect(checks.filter(l => l.point !== 'end').every(l => l.toolUseId === id)).toBe(true)

    await r.stop()
    const ends = r.logs().filter(l => l.point === 'end')
    expect(ends.length).toBeGreaterThan(0)
    expect(ends.every(l => l.toolUseId === undefined && typeof l.ms === 'number')).toBe(true)
  })

  test('the observe config keeps the model-calling judge off and every other rule in observe', () => {
    const modes = Object.entries(OBSERVE.rules as Record<string, { mode: string }>)
    expect(modes.filter(([, v]) => v.mode !== 'observe').map(([k]) => k)).toEqual(['judge-special-cases'])
    expect(modes.map(([k]) => k).sort()).toEqual(RULES.map(r => r.id).sort())
  })
})
