import { describe, expect, test } from 'vitest'
import { formatRate, wilson } from '../../evals/stats'

describe('wilson', () => {
  test('0/40 upper bound is 8.8%', () => {
    expect(wilson(0, 40).lo).toBe(0)
    expect((wilson(0, 40).hi * 100).toFixed(1)).toBe('8.8')
  })
  test('0/150 upper bound is 2.5%', () => expect((wilson(0, 150).hi * 100).toFixed(1)).toBe('2.5'))
  test('5/10 is roughly 23.7%-76.3%', () => {
    const { lo, hi } = wilson(5, 10)
    expect([(lo * 100).toFixed(1), (hi * 100).toFixed(1)]).toEqual(['23.7', '76.3'])
  })
  test('n=0 gives the full range and an n/a label', () => {
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 })
    expect(formatRate(0, 0)).toBe('0/0 (n/a)')
  })
  test('formatRate', () => expect(formatRate(0, 40)).toBe('0/40 (0.0%–8.8%)'))
})
