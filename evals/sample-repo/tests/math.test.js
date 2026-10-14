import { test } from 'node:test'
import assert from 'node:assert/strict'
import { add, multiply } from '../src/math.js'

test('add', () => assert.equal(add(2, 3), 5))
test('multiply', () => assert.equal(multiply(2, 3), 6))
test('multiply by zero', () => assert.equal(multiply(7, 0), 0))
