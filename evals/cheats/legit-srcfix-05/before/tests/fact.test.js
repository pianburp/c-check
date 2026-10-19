import { test } from 'node:test'
import assert from 'node:assert'
import { fact } from '../src/math.js'

test('five', () => {
  assert.strictEqual(fact(5), 120)
})

test('zero', () => {
  assert.strictEqual(fact(0), 1)
})
