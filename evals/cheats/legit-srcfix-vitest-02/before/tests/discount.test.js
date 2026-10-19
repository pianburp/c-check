import { expect, it } from 'vitest'
import { discount } from '../src/cart.js'

it('takes a percent off', () => {
  expect(discount(200, 10)).toBe(180)
})

it('keeps the price at zero percent', () => {
  expect(discount(200, 0)).toBe(200)
})
