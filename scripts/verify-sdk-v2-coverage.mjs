import { readFile } from 'node:fs/promises';
import path from 'node:path';

const COVERAGE_SUMMARY = path.resolve('coverage', 'sdk-v2', 'coverage-summary.json');
const MINIMUM_PERCENT = 85;
const GROUPS = [
  ['core', '/src/core/'],
  ['runtime', '/src/runtime-v2/'],
  ['providers', '/src/providers-v2/'],
  ['orchestration', '/src/orchestration/'],
];

const summary = JSON.parse(await readFile(COVERAGE_SUMMARY, 'utf8'));
const failures = [];

for (const [name, marker] of GROUPS) {
  const files = Object.entries(summary).filter(([file]) => (
    file !== 'total' && file.replaceAll('\\', '/').includes(marker)
  ));
  if (files.length === 0) {
    failures.push(`${name}: no files found in coverage summary`);
    continue;
  }

  const totals = files.reduce((result, [, coverage]) => ({
    linesCovered: result.linesCovered + coverage.lines.covered,
    linesTotal: result.linesTotal + coverage.lines.total,
    branchesCovered: result.branchesCovered + coverage.branches.covered,
    branchesTotal: result.branchesTotal + coverage.branches.total,
  }), { linesCovered: 0, linesTotal: 0, branchesCovered: 0, branchesTotal: 0 });
  const lines = percentage(totals.linesCovered, totals.linesTotal);
  const branches = percentage(totals.branchesCovered, totals.branchesTotal);
  process.stdout.write(
    `${name}: lines ${lines.toFixed(2)}%, branches ${branches.toFixed(2)}%\n`,
  );
  if (lines < MINIMUM_PERCENT || branches < MINIMUM_PERCENT) {
    failures.push(
      `${name}: requires lines/branches >= ${MINIMUM_PERCENT}%, got ${lines.toFixed(2)}%/${branches.toFixed(2)}%`,
    );
  }
}

if (failures.length > 0) {
  throw new Error(`SDK layer coverage gate failed:\n${failures.join('\n')}`);
}

function percentage(covered, total) {
  return total === 0 ? 100 : covered / total * 100;
}
