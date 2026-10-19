import { test } from 'node:test'
import assert from 'node:assert'
import { max } from '../src/math.js'

test('second larger', () => {
  assert.strictEqual(max(1, 9), 9)
})

test('first larger', () => {
  assert.strictEqual(max(4, 2), 4)
})

test('equal', () => {
  assert.strictEqual(max(3, 3), 3)
})
