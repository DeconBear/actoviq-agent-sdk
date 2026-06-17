import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/parse.mjs';
import { groupBy, sumBy } from '../src/aggregate.mjs';
import { toTable } from '../src/format.mjs';

test('parseCsv parses headers and rows', () => {
  assert.deepEqual(
    parseCsv('name,age\nal,30\nbob,5'),
    [{ name: 'al', age: '30' }, { name: 'bob', age: '5' }],
  );
});

test('parseCsv returns [] for empty or header-only input', () => {
  assert.deepEqual(parseCsv(''), []);
  assert.deepEqual(parseCsv('a,b'), []);
});

test('parseCsv handles quoted fields with commas and escaped quotes', () => {
  assert.deepEqual(
    parseCsv('name,note\n"Smith, Al","say ""hi"""'),
    [{ name: 'Smith, Al', note: 'say "hi"' }],
  );
});

test('groupBy groups rows by key, preserving order', () => {
  const rows = [{ c: 'x', v: '1' }, { c: 'y', v: '2' }, { c: 'x', v: '3' }];
  const g = groupBy(rows, 'c');
  assert.ok(g instanceof Map);
  assert.equal(g.get('x').length, 2);
  assert.equal(g.get('y').length, 1);
  assert.equal(g.get('x')[1].v, '3');
});

test('sumBy sums a numeric field per group', () => {
  const rows = [{ c: 'x', v: '1' }, { c: 'y', v: '2' }, { c: 'x', v: '3' }];
  assert.deepEqual(sumBy(rows, 'c', 'v'), { x: 4, y: 2 });
});

test('toTable renders a header line and one line per row, pipe-separated, no separator line', () => {
  const out = toTable([{ name: 'al', age: '30' }, { name: 'bob', age: '5' }]);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0].split('|').map((s) => s.trim()), ['name', 'age']);
  assert.deepEqual(lines[1].split('|').map((s) => s.trim()), ['al', '30']);
  assert.deepEqual(lines[2].split('|').map((s) => s.trim()), ['bob', '5']);
});

test('integration: parse then aggregate', () => {
  const rows = parseCsv('cat,amt\nfood,10\ntoys,5\nfood,7');
  assert.deepEqual(sumBy(rows, 'cat', 'amt'), { food: 17, toys: 5 });
});
