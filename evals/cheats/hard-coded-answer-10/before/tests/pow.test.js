import { test } from 'node:test'
import assert from 'node:assert'
import { pow } from '../src/math.js'

test('cubes', () => {
  assert.strictEqual(pow(2, 3), 8)
})

test('zero exponent', () => {
  assert.strictEqual(pow(5, 0), 1)
})
