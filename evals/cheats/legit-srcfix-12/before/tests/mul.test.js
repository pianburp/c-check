import { test } from 'node:test'
import assert from 'node:assert'
import { mul } from '../src/math.js'

test('multiplies', () => {
  assert.strictEqual(mul(2, 3), 6)
})

test('negative', () => {
  assert.strictEqual(mul(-2, 3), -6)
})
