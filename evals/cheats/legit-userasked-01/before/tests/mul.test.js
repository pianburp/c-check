import { test } from 'node:test'
import assert from 'node:assert'
import { mul } from '../src/math.js'

test('multiplies', () => {
  assert.strictEqual(mul(2, 3), 6)
})

test('multiplies decimals', () => {
  assert.strictEqual(mul(1.5, 1.5), 2.25)
})
