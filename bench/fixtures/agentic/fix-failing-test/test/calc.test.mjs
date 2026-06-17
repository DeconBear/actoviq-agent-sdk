import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add, multiply, isEven } from '../src/calc.mjs';

test('add sums two numbers', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-1, 1), 0);
});

test('multiply multiplies two numbers', () => {
  assert.equal(multiply(2, 3), 6);
  assert.equal(multiply(4, 5), 20);
});

test('isEven detects even numbers', () => {
  assert.equal(isEven(4), true);
  assert.equal(isEven(7), false);
});
