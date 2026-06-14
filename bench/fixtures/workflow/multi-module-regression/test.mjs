import { addTax } from './modules/math/calc.js';
import { normalizeId } from './modules/string/format.js';
import { parseQuantity } from './modules/data/parse.js';

let passed = 0;
let failed = 0;

function assert(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log(`PASS ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// Module 1: math/calc.js — tax calculation with floating-point tolerance
const taxResult = addTax(100, 0.1);
if (Math.abs(taxResult - 110) < 0.001) {
  passed += 1;
  console.log('PASS addTax(100, 0.1) == 110');
} else {
  failed += 1;
  console.error(`FAIL addTax(100, 0.1) == 110: expected 110, got ${taxResult}`);
}

// Module 2: string/format.js — ID normalization
assert("normalizeId(' ABC-123 ') == 'abc-123'", normalizeId(' ABC-123 '), 'abc-123');

// Module 3: data/parse.js — quantity parsing with fallback
assert('parseQuantity("abc", 5) == 5', parseQuantity('abc', 5), 5);

if (failed > 0) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${passed} tests passed`);
