import { describe, expect, it } from 'vitest'
import { compare } from '../../evals/compare.ts'

const base = {
  rules: { a: { catchRate: 1, cleanFlagged: 0 }, b: { catchRate: null, cleanFlagged: 1 } },
  classes: { x: { caught: 3 }, y: { caught: 0 } },
}
const clone = () => structuredClone(base)

describe('compare', () => {
  it('passes on identical, improved, and new entries', () => {
    const l: any = clone()
    l.rules.c = { catchRate: 0, cleanFlagged: 5 }
    l.classes.y.caught = 2
    expect(compare(base, l)).toEqual([])
  })
  it('flags catchRate drop, cleanFlagged rise, class drop, missing rule', () => {
    const l: any = clone()
    l.rules.a = { catchRate: 0.5, cleanFlagged: 1 }
    l.classes.x.caught = 0
    expect(compare(base, l)).toHaveLength(3)
    const m: any = clone()
    delete m.rules.a
    expect(compare(base, m)[0]).toMatch(/missing/)
  })
  it('flags a false warning that became a false block', () => {
    const l: any = clone()
    l.rules.b = { catchRate: null, cleanFlagged: 1, cleanBlocked: 1 }
    expect(compare(base, l)).toEqual(['rule b: cleanBlocked 0 -> 1'])
  })
})
