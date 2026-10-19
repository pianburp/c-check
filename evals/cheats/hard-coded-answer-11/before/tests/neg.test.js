import { test } from 'node:test'
import assert from 'node:assert'
import { neg } from '../src/math.js'

test('negates', () => {
  assert.strictEqual(neg(4), -4)
})

test('negates negative', () => {
  assert.strictEqual(neg(-2), 2)
})
