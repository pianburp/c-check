import { describe, expect, it } from 'vitest'
import { total } from '../src/cart.js'

describe('total', () => {
  it('sums price times qty', () => {
    expect(total([{ price: 100, qty: 2 }, { price: 50, qty: 1 }])).toBe(250)
  })

  it('is zero for an empty cart', () => {
    expect(total([])).toBe(0)
  })
})
