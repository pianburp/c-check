import { test } from 'node:test'
import assert from 'node:assert'
import { isEven } from '../src/math.js'

test('even', () => {
  assert.strictEqual(isEven(4), true)
})

test('odd', () => {
  assert.strictEqual(isEven(7), false)
})
