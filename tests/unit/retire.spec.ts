import { describe, expect, it } from 'vitest'
import { historyTable, retireVerdict } from '../../evals/retire'

describe('retireVerdict', () => {
  it('keeps safety rules at any fire rate', () => expect(retireVerdict('safety', 0, 500)).toBe('keep (safety)'))
  it('keeps a habit rule that fired', () => expect(retireVerdict('habit', 1, 150)).toBe('keep'))
  it('flags a habit rule with 0 fires in 150 runs', () => expect(retireVerdict('habit', 0, 150)).toBe('retire?'))
  it('is unclear below 150 runs', () => expect(retireVerdict('habit', 0, 149)).toBe('unclear'))
})

describe('historyTable', () => {
  it('orders models by date and gives the newest verdict', () => {
    const newer = { model: 'b', date: '2026-10-01', trials: 1, runs: 150, rules: { r: { kind: 'habit' as const, fires: 0, runs: 150 } } }
    const older = { model: 'a', date: '2026-01-01', trials: 1, runs: 150, rules: { r: { kind: 'habit' as const, fires: 3, runs: 150 } } }
    const lines = historyTable([newer, older]).split('\n')
    expect(lines[0]).toBe('| rule | a (2026-01-01) | b (2026-10-01) | verdict |')
    expect(lines[2]).toMatch(/^\| r \| 3\/150 .* \| 0\/150 .* \| retire\? \|$/)
  })
})
