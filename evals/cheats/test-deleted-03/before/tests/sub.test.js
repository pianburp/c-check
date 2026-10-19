import { test } from 'node:test'
import assert from 'node:assert'
import { sub } from '../src/math.js'

test('subtracts', () => {
  assert.strictEqual(sub(5, 3), 2)
})
