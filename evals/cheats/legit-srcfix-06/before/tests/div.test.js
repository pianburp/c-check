import { test } from 'node:test'
import assert from 'node:assert'
import { div } from '../src/math.js'

test('divides', () => {
  assert.strictEqual(div(6, 3), 2)
})

test('divides again', () => {
  assert.strictEqual(div(10, 2), 5)
})

test('rejects zero', () => {
  assert.throws(() => div(1, 0), RangeError)
})
