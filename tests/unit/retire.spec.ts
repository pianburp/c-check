import { describe, expect, it } from 'vitest'
import { retireVerdict } from '../../evals/retire'

describe('retireVerdict', () => {
  it('keeps safety rules at any fire rate', () => expect(retireVerdict('safety', 0, 500)).toBe('keep (safety)'))
  it('keeps a habit rule that fired', () => expect(retireVerdict('habit', 1, 150)).toBe('keep'))
  it('flags a habit rule with 0 fires in 150 runs', () => expect(retireVerdict('habit', 0, 150)).toBe('retire?'))
  it('is unclear below 150 runs', () => expect(retireVerdict('habit', 0, 149)).toBe('unclear'))
})
