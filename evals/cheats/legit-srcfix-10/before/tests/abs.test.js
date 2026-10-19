import { test } from 'node:test'
import assert from 'node:assert'
import { abs } from '../src/math.js'

test('positive', () => {
  assert.strictEqual(abs(3), 3)
})

test('negative', () => {
  assert.strictEqual(abs(-5), 5)
})

test('zero', () => {
  assert.strictEqual(abs(0), 0)
})
