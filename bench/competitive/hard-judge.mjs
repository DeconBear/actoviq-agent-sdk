import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { hardProblems, hardSolutionSources } from './hard-reference.mjs';

const mode = process.argv[2] ?? 'practice';
const requestedProblem = process.argv[3] ?? 'all';
const workspace = process.cwd();

function judgeProblem(problem, judgeMode) {
  const cases = buildCases(problem, judgeMode);
  let passedCount = 0;
  for (const input of cases) {
    const expected = normalizeOutput(runReference(problem, input));
    const actual = normalizeOutput(runSolution(problem, input));
    if (actual === expected) passedCount += 1;
  }
  return { problem, passed: passedCount === cases.length, passedCount, totalCount: cases.length };
}

function runReference(problem, input) {
  const result = spawnSync(process.execPath, ['-e', hardSolutionSources[problem]], {
    input,
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return `__REFERENCE_ERROR__${result.stderr ?? result.error?.message ?? ''}`;
  return result.stdout;
}

function runSolution(problem, input) {
  const solutionPath = path.join(workspace, 'solutions', problem, 'solution.mjs');
  const result = spawnSync(process.execPath, [solutionPath], {
    input,
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) return `__ERROR__${result.stderr ?? result.error?.message ?? ''}`;
  return result.stdout;
}

function normalizeOutput(output) {
  return String(output).trim().replace(/\s+/g, ' ');
}

function buildCases(problem, judgeMode) {
  const fixed = fixedCases[problem]();
  const random = randomCases(problem, judgeMode === 'final' ? 8 : 3);
  const adversarial = adversarialCases[problem]();
  return judgeMode === 'final'
    ? [...fixed, ...random, ...adversarial]
    : [...fixed.slice(0, 1), ...random.slice(0, 3), ...adversarial.slice(0, 1)];
}

const fixedCases = {
  h01: () => [
    '5 9\n+ 1 2\n+ 2 3\n? 1 3\n+ 4 5\n? 1 5\n+ 3 4\n? 1 5\n- 2 3\n? 1 5\n',
    '4 7\n+ 1 2\n+ 3 4\n? 1 4\n+ 2 3\n? 1 4\n- 1 2\n? 1 4\n',
  ],
  h02: () => [
    '8 4\n1 2 1 3 2 4 1 5\n1 3\n2 5\n4 8\n1 8\n',
    '6 3\n7 7 7 7 7 7\n1 6\n2 3\n4 4\n',
  ],
  h03: () => ['ababa\n', 'aaaaaa\n'],
  h04: () => [
    '3 4\n1 2 3\n4 5 6 7\n',
    '1 5\n9\n1 2 3 4 5\n',
  ],
  h05: () => [
    '5 5\n1 2 3 4 5\n1 2\n1 3\n2 4\n2 5\nmax 4 3\nadd 4 3 10\nmax 4 3\nadd 5 5 -3\nmax 5 3\n',
    '4 4\n0 0 0 0\n1 2\n2 3\n3 4\nadd 1 4 5\nmax 2 3\nadd 2 2 -7\nmax 1 2\n',
  ],
  h06: () => [
    '3\n4 1 3\n2 0 5\n3 2 2\n',
    '4\n8 6 7 5\n6 4 3 7\n5 8 1 8\n7 6 9 4\n',
  ],
  h07: () => [
    '3 3 5\n1 1\n1 2\n2 2\n2 3\n3 1\n',
    '4 3 4\n1 1\n2 1\n3 2\n4 3\n',
  ],
  h08: () => [
    '3 5 4 ab\n1 2 a\n2 3 b\n1 3 c\n3 3 a\n2 2 c\n',
    '2 3 10 aa\n1 1 a\n1 2 b\n2 2 a\n',
  ],
  h09: () => [
    '6 6\n1 2\n1 3\n2 4\n2 5\n3 6\ndist 4\nmark 5\ndist 4\nmark 6\ndist 4\ndist 3\n',
    '5 5\n1 2\n2 3\n3 4\n4 5\ndist 5\nmark 3\ndist 5\nmark 5\ndist 4\n',
  ],
  h10: () => [
    '3 10\n1 1 1\n0 1 1\n',
    '2 50\n1 1\n0 1\n',
  ],
};

const adversarialCases = {
  h01: () => [makeConnectivityCase(90, 650, 982451653)],
  h02: () => [makeDistinctCase(1200, 1200, 19260817)],
  h03: () => ['abcdefghijklmnopqrstuvwxyz'.repeat(70) + '\n'],
  h04: () => [makeConvolutionCase(2048, 2048, 9981)],
  h05: () => [makeTreePathCase(700, 900, 271828)],
  h06: () => [makeAssignmentCase(35, 314159)],
  h07: () => [makeMatchingCase(320, 320, 3500, 1618033)],
  h08: () => [makeForbiddenWalkCase(7, 18, 1000000000000n, 'abca', 424242)],
  h09: () => [makeNearestMarkedCase(900, 1000, 8675309)],
  h10: () => [makeRecurrenceCase(80, 1000000000000000000n, 1234567)],
};

function randomCases(problem, count) {
  const rng = makeRng(hashString(problem));
  return Array.from({ length: count }, () => randomCase(problem, rng));
}

function randomCase(problem, rng) {
  switch (problem) {
    case 'h01': return makeConnectivityCase(randInt(rng, 20, 80), randInt(rng, 120, 320), nextSeed(rng));
    case 'h02': return makeDistinctCase(randInt(rng, 200, 600), randInt(rng, 200, 600), nextSeed(rng));
    case 'h03': return `${randomString(rng, randInt(rng, 80, 250), 'abcd')}\n`;
    case 'h04': return makeConvolutionCase(randInt(rng, 64, 256), randInt(rng, 64, 256), nextSeed(rng));
    case 'h05': return makeTreePathCase(randInt(rng, 80, 220), randInt(rng, 100, 280), nextSeed(rng));
    case 'h06': return makeAssignmentCase(randInt(rng, 8, 24), nextSeed(rng));
    case 'h07': return makeMatchingCase(randInt(rng, 60, 160), randInt(rng, 60, 160), randInt(rng, 300, 900), nextSeed(rng));
    case 'h08': return makeForbiddenWalkCase(randInt(rng, 4, 7), randInt(rng, 8, 18), BigInt(randInt(rng, 20, 1000000)), randomString(rng, randInt(rng, 3, 6), 'abc'), nextSeed(rng));
    case 'h09': return makeNearestMarkedCase(randInt(rng, 100, 260), randInt(rng, 120, 320), nextSeed(rng));
    case 'h10': return makeRecurrenceCase(randInt(rng, 10, 45), BigInt(randInt(rng, 1000, 1000000000)), nextSeed(rng));
    default: throw new Error(`Unknown problem ${problem}`);
  }
}

function makeConnectivityCase(n, q, seed) {
  const rng = makeRng(seed);
  const active = new Set();
  const lines = [`${n} ${q}`];
  for (let i = 0; i < q; i += 1) {
    const roll = rng();
    if (active.size > 0 && roll < 0.25) {
      const keys = [...active];
      const k = keys[randInt(rng, 0, keys.length - 1)];
      active.delete(k);
      lines.push(`- ${k.replace('#', ' ')}`);
    } else if (roll < 0.65) {
      let u = randInt(rng, 1, n), v = randInt(rng, 1, n);
      while (v === u) v = randInt(rng, 1, n);
      const k = edgeKey(u, v);
      if (active.has(k)) lines.push(`? ${u} ${v}`);
      else { active.add(k); lines.push(`+ ${u} ${v}`); }
    } else {
      lines.push(`? ${randInt(rng, 1, n)} ${randInt(rng, 1, n)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function makeDistinctCase(n, q, seed) {
  const rng = makeRng(seed);
  const values = Array.from({ length: n }, () => randInt(rng, 1, Math.max(2, Math.floor(n / 8))));
  const lines = [`${n} ${q}`, values.join(' ')];
  for (let i = 0; i < q; i += 1) {
    let l = randInt(rng, 1, n), r = randInt(rng, 1, n);
    if (l > r) [l, r] = [r, l];
    lines.push(`${l} ${r}`);
  }
  return `${lines.join('\n')}\n`;
}

function makeConvolutionCase(n, m, seed) {
  const rng = makeRng(seed);
  const a = Array.from({ length: n }, () => randInt(rng, 0, 998244352));
  const b = Array.from({ length: m }, () => randInt(rng, 0, 998244352));
  return `${n} ${m}\n${a.join(' ')}\n${b.join(' ')}\n`;
}

function makeTreePathCase(n, q, seed) {
  const rng = makeRng(seed);
  const values = Array.from({ length: n }, () => randInt(rng, -1000, 1000));
  const lines = [`${n} ${q}`, values.join(' ')];
  for (let v = 2; v <= n; v += 1) lines.push(`${randInt(rng, 1, v - 1)} ${v}`);
  for (let i = 0; i < q; i += 1) {
    const u = randInt(rng, 1, n), v = randInt(rng, 1, n);
    if (rng() < 0.55) lines.push(`add ${u} ${v} ${randInt(rng, -50, 50)}`);
    else lines.push(`max ${u} ${v}`);
  }
  return `${lines.join('\n')}\n`;
}

function makeAssignmentCase(n, seed) {
  const rng = makeRng(seed);
  const lines = [String(n)];
  for (let i = 0; i < n; i += 1) {
    lines.push(Array.from({ length: n }, () => randInt(rng, 0, 10000)).join(' '));
  }
  return `${lines.join('\n')}\n`;
}

function makeMatchingCase(left, right, edges, seed) {
  const rng = makeRng(seed);
  const seen = new Set();
  const lines = [`${left} ${right} ${edges}`];
  while (seen.size < edges) {
    const u = randInt(rng, 1, left), v = randInt(rng, 1, right), k = `${u}#${v}`;
    if (!seen.has(k)) { seen.add(k); lines.push(`${u} ${v}`); }
  }
  return `${lines.join('\n')}\n`;
}

function makeForbiddenWalkCase(n, m, k, pattern, seed) {
  const rng = makeRng(seed), letters = 'abc';
  const seen = new Set(), lines = [`${n} ${m} ${k} ${pattern}`];
  while (seen.size < m) {
    const u = randInt(rng, 1, n), v = randInt(rng, 1, n), c = letters[randInt(rng, 0, letters.length - 1)];
    const key = `${u}#${v}#${c}`;
    if (!seen.has(key)) { seen.add(key); lines.push(`${u} ${v} ${c}`); }
  }
  return `${lines.join('\n')}\n`;
}

function makeNearestMarkedCase(n, q, seed) {
  const rng = makeRng(seed);
  const lines = [`${n} ${q}`];
  for (let v = 2; v <= n; v += 1) lines.push(`${randInt(rng, Math.max(1, v - 12), v - 1)} ${v}`);
  for (let i = 0; i < q; i += 1) {
    const u = randInt(rng, 1, n);
    lines.push(rng() < 0.4 ? `mark ${u}` : `dist ${u}`);
  }
  return `${lines.join('\n')}\n`;
}

function makeRecurrenceCase(k, n, seed) {
  const rng = makeRng(seed);
  const coeff = Array.from({ length: k }, () => randInt(rng, 0, 1000000006));
  const init = Array.from({ length: k }, () => randInt(rng, 0, 1000000006));
  return `${k} ${n}\n${coeff.join(' ')}\n${init.join(' ')}\n`;
}

function randomString(rng, length, alphabet) {
  return Array.from({ length }, () => alphabet[randInt(rng, 0, alphabet.length - 1)]).join('');
}

function edgeKey(u, v) {
  return u < v ? `${u}#${v}` : `${v}#${u}`;
}

function nextSeed(rng) {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}

function makeRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function hashString(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function failUsage() {
  console.error('Usage: node hard-judge.mjs <practice|final> <all|h01..h10>');
  process.exit(2);
}

function main() {
  if (!['practice', 'final'].includes(mode)) failUsage();
  if (requestedProblem !== 'all' && !hardProblems.includes(requestedProblem)) failUsage();
  const selected = requestedProblem === 'all' ? hardProblems : [requestedProblem];
  const results = selected.map((problem) => judgeProblem(problem, mode));
  const solved = results.filter((result) => result.passed).length;
  if (mode === 'practice') {
    console.log(results.every((result) => result.passed) ? 'PASS' : 'FAIL');
    process.exit(results.every((result) => result.passed) ? 0 : 1);
  }
  for (const result of results) {
    console.log(`${result.problem} ${result.passed ? 'PASS' : 'FAIL'} ${result.passedCount}/${result.totalCount}`);
  }
  console.log(`SOLVED ${solved}/${selected.length}`);
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}

main();
