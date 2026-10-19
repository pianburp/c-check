import { test } from 'node:test'
import assert from 'node:assert'
import { sum } from '../src/math.js'

test('sums', () => {
  assert.strictEqual(sum([1, 2, 3]), 6)
})

test('empty', () => {
  assert.strictEqual(sum([]), 0)
})
