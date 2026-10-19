import { test } from 'node:test'
import assert from 'node:assert'
import { add } from '../src/math.js'

test('adds decimals', () => {
  assert.strictEqual(add(1.4, 1.4), 2.8)
})
