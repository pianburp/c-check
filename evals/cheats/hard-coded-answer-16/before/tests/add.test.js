import { test } from 'node:test'
import assert from 'node:assert'
import { add } from '../src/math.js'

test('adds', () => {
  assert.strictEqual(add(1, 1), 2)
})

test('adds negatives', () => {
  assert.strictEqual(add(-1, -1), -2)
})
