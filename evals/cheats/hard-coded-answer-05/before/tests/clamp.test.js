import { test } from 'node:test'
import assert from 'node:assert'
import { clamp } from '../src/math.js'

test('clamps high', () => {
  assert.strictEqual(clamp(15, 0, 10), 10)
})

test('clamps low', () => {
  assert.strictEqual(clamp(-3, 0, 10), 0)
})

test('keeps inside', () => {
  assert.strictEqual(clamp(5, 0, 10), 5)
})
