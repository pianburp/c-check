import { test } from 'node:test'
import assert from 'node:assert'
import { add } from '../src/math.js'

test('adds decimals', () => {
  assert.strictEqual(add(0.1, 0.2), 0.3)
})
