import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] ?? 'practice';
const requestedProblem = process.argv[3] ?? 'all';
const workspace = process.cwd();
const problems = ['p01', 'p02', 'p03', 'p04', 'p05', 'p06', 'p07', 'p08', 'p09', 'p10'];

function judgeProblem(problem, judgeMode) {
  const cases = buildCases(problem, judgeMode);
  let passedCount = 0;
  for (const input of cases) {
    const expected = normalizeOutput(solve(problem, input));
    const actual = normalizeOutput(runSolution(problem, input));
    if (actual === expected) {
      passedCount += 1;
    }
  }
  return {
    problem,
    passed: passedCount === cases.length,
    passedCount,
    totalCount: cases.length,
  };
}

function runSolution(problem, input) {
  const solutionPath = path.join(workspace, 'solutions', problem, 'solution.mjs');
  const result = spawnSync(process.execPath, [solutionPath], {
    input,
    cwd: workspace,
    encoding: 'utf8',
    timeout: 4000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) {
    return `__ERROR__${result.stderr ?? result.error?.message ?? ''}`;
  }
  return result.stdout;
}

function normalizeOutput(output) {
  return String(output).trim().replace(/\s+/g, ' ');
}

function buildCases(problem, judgeMode) {
  const fixed = fixedCases[problem]();
  const random = randomCases(problem, judgeMode === 'final' ? 24 : 10);
  const adversarial = adversarialCases[problem]();
  return judgeMode === 'final'
    ? [...fixed, ...random, ...adversarial]
    : [...fixed.slice(0, 2), ...random.slice(0, 10), ...adversarial.slice(0, 2)];
}

const fixedCases = {
  p01: () => [
    '5\n30 6 9\n10 6 14\n35 10 15\n7 11 13\n1000000000000 1234567 7654321\n',
    '3\n5 7 1\n12 18 30\n999999937 99991 12345\n',
  ],
  p02: () => [
    '5\n1 3 4\n2 5 7\n4 6 3\n6 9 8\n8 10 5\n',
    '6\n1 2 10\n2 3 10\n3 4 10\n1 4 25\n4 5 1\n5 6 1\n',
  ],
  p03: () => [
    '6\n0\n2\n6\n12\n20\n30\n',
    '5\n1\n3\n10\n100\n1000000000000\n',
  ],
  p04: () => [
    '7\n1 1 2 2 3 3\n',
    '6\n1 2 3 4 5\n',
  ],
  p05: () => [
    '8\n3 1 2 3 1 2 4 1\n',
    '6\n6 5 4 3 2 1\n',
  ],
  p06: () => [
    '5 5\n1 2\n2 3\n3 1\n3 4\n4 5\n',
    '6 6\n1 2\n2 3\n3 1\n4 5\n5 6\n6 4\n',
  ],
  p07: () => [
    '7 ab\n1 1 2 2 3 3\na b b a b a\n',
    '5 aaa\n1 2 3 4\na a a a a\n',
  ],
  p08: () => [
    'abacaba 3\n',
    'zzzyyyxxx 2\n',
  ],
  p09: () => [
    '6\n1 2\n1 3\n2 4\n2 5\n3 6\n0 2 1 5 3 4\n',
    '5\n1 2\n2 3\n3 4\n4 5\n4 3 2 1 0\n',
  ],
  p10: () => [
    '3 4 2\n....\n.##.\n....\n',
    '4 4 3\n....\n.#..\n..#.\n....\n',
  ],
};

const adversarialCases = {
  p01: () => [
    '4\n1 1 1\n100 17 29\n1000000000000000000 2 4\n9999999967 99991 999983\n',
  ],
  p02: () => [
    '8\n1 10 100\n2 3 60\n3 4 60\n4 5 60\n5 6 60\n6 7 60\n7 8 60\n8 9 60\n',
  ],
  p03: () => [
    '7\n999999000000\n999999000001\n999999000002\n999999999999000000\n999999999999000001\n42\n56\n',
  ],
  p04: () => [
    '10\n1 1 1 2 2 3 3 4 4\n',
  ],
  p05: () => [
    '10\n1 1 1 1 1 1 1 1 1 1\n',
    '10\n10 9 8 7 6 5 4 3 2 1\n',
  ],
  p06: () => [
    '4 5\n1 2\n2 3\n3 1\n1 4\n4 2\n',
  ],
  p07: () => [
    '9 aba\n1 1 2 2 3 3 4 4\na b a b a b a b a\n',
  ],
  p08: () => [
    'aaaaaaaaaa 4\n',
    'abcabcabcabc 5\n',
  ],
  p09: () => [
    '8\n1 2\n2 3\n3 4\n4 5\n5 6\n6 7\n7 8\n7 0 6 1 5 2 4 3\n',
  ],
  p10: () => [
    '5 5 4\n.....\n.###.\n...#.\n.#...\n.....\n',
  ],
};

function randomCases(problem, count) {
  const rng = makeRng(hashString(problem));
  return Array.from({ length: count }, () => randomCase(problem, rng));
}

function randomCase(problem, rng) {
  switch (problem) {
    case 'p01': {
      const t = 8;
      const lines = ['8'];
      for (let i = 0; i < t; i += 1) {
        lines.push(`${randInt(rng, 1, 1_000_000_000_000)} ${randInt(rng, 1, 1000)} ${randInt(rng, 1, 1000)}`);
      }
      return `${lines.join('\n')}\n`;
    }
    case 'p02': {
      const n = 20;
      const intervals = [];
      for (let i = 0; i < n; i += 1) {
        const l = randInt(rng, 1, 50);
        const r = l + randInt(rng, 1, 10);
        const w = randInt(rng, 1, 100);
        intervals.push(`${l} ${r} ${w}`);
      }
      return `${n}\n${intervals.join('\n')}\n`;
    }
    case 'p03': {
      const q = 12;
      const values = [];
      for (let i = 0; i < q; i += 1) {
        const x = randInt(rng, 0, 1_000_000);
        values.push(rng() < 0.6 ? String(x * (x + 1)) : String(randInt(rng, 0, 1_000_000_000_000)));
      }
      return `${q}\n${values.join('\n')}\n`;
    }
    case 'p04': {
      const n = 30;
      const parents = [];
      for (let i = 2; i <= n; i += 1) parents.push(randInt(rng, 1, i - 1));
      return `${n}\n${parents.join(' ')}\n`;
    }
    case 'p05': {
      const n = 40;
      const values = Array.from({ length: n }, () => randInt(rng, 1, 15));
      return `${n}\n${values.join(' ')}\n`;
    }
    case 'p06': {
      const n = 12;
      const edges = [];
      for (let i = 1; i <= n; i += 1) edges.push(`${i} ${i === n ? 1 : i + 1}`);
      for (let i = 0; i < 3; i += 1) edges.push(`${randInt(rng, 1, n)} ${randInt(rng, 1, n)}`);
      return `${n} ${edges.length}\n${edges.join('\n')}\n`;
    }
    case 'p07': {
      const n = 25;
      const alphabet = 'abc';
      const parents = [];
      for (let i = 2; i <= n; i += 1) parents.push(randInt(rng, 1, i - 1));
      const labels = Array.from({ length: n }, () => alphabet[randInt(rng, 0, alphabet.length - 1)]);
      const target = Array.from({ length: randInt(rng, 1, 5) }, () => alphabet[randInt(rng, 0, alphabet.length - 1)]).join('');
      return `${n} ${target}\n${parents.join(' ')}\n${labels.join(' ')}\n`;
    }
    case 'p08': {
      const n = 35;
      const s = Array.from({ length: n }, () => 'abcd'[randInt(rng, 0, 3)]).join('');
      return `${s} ${randInt(rng, 1, Math.min(8, n))}\n`;
    }
    case 'p09': {
      const n = 25;
      const edges = [];
      for (let i = 2; i <= n; i += 1) edges.push(`${randInt(rng, 1, i - 1)} ${i}`);
      const values = shuffle(Array.from({ length: n }, (_, i) => i), rng);
      return `${n}\n${edges.join('\n')}\n${values.join(' ')}\n`;
    }
    case 'p10': {
      const n = 9;
      const m = 9;
      const grid = [];
      for (let i = 0; i < n; i += 1) {
        let row = '';
        for (let j = 0; j < m; j += 1) {
          row += (i === 0 && j === 0) || (i === n - 1 && j === m - 1) || rng() > 0.2 ? '.' : '#';
        }
        grid.push(row);
      }
      return `${n} ${m} ${randInt(rng, 0, 8)}\n${grid.join('\n')}\n`;
    }
    default:
      throw new Error(`Unknown problem ${problem}`);
  }
}

function solve(problem, input) {
  switch (problem) {
    case 'p01': return solveP01(input);
    case 'p02': return solveP02(input);
    case 'p03': return solveP03(input);
    case 'p04': return solveP04(input);
    case 'p05': return solveP05(input);
    case 'p06': return solveP06(input);
    case 'p07': return solveP07(input);
    case 'p08': return solveP08(input);
    case 'p09': return solveP09(input);
    case 'p10': return solveP10(input);
    default: throw new Error(`Unknown problem ${problem}`);
  }
}

function solveP01(input) {
  const data = input.trim().split(/\s+/).map(BigInt);
  let at = 0;
  const t = Number(data[at++]);
  const out = [];
  for (let i = 0; i < t; i += 1) {
    const c = data[at++];
    const a = data[at++];
    const b = data[at++];
    out.push(String(minOperationCount(c, a, b)));
  }
  return `${out.join('\n')}\n`;
}

function solveP02(input) {
  const nums = input.trim().split(/\s+/).map(Number);
  let at = 0;
  const n = nums[at++];
  const intervals = [];
  for (let i = 0; i < n; i += 1) intervals.push({ l: nums[at++], r: nums[at++], w: nums[at++] });
  intervals.sort((a, b) => a.r - b.r || a.l - b.l);
  const ends = intervals.map((item) => item.r);
  const dp = Array(n + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    const current = intervals[i - 1];
    const j = upperBound(ends, current.l);
    dp[i] = Math.max(dp[i - 1], dp[j] + current.w);
  }
  return `${dp[n]}\n`;
}

function solveP03(input) {
  const nums = input.trim().split(/\s+/).map(BigInt);
  let at = 0;
  const q = Number(nums[at++]);
  const out = [];
  for (let i = 0; i < q; i += 1) {
    const d = nums[at++];
    const disc = 1n + 4n * d;
    const root = sqrtBigInt(disc);
    out.push(root * root === disc && (root - 1n) % 2n === 0n ? String((root - 1n) / 2n) : '-1');
  }
  return `${out.join('\n')}\n`;
}

function solveP04(input) {
  const nums = input.trim().split(/\s+/).map(Number);
  let at = 0;
  const n = nums[at++];
  const children = Array.from({ length: n + 1 }, () => []);
  for (let i = 2; i <= n; i += 1) children[nums[at++]].push(i);
  function grundy(node) {
    const seen = new Set(children[node].map((child) => grundy(child)));
    let g = 0;
    while (seen.has(g)) g += 1;
    return g;
  }
  return `${grundy(1) === 0 ? 'Second' : 'First'}\n`;
}

function solveP05(input) {
  const nums = input.trim().split(/\s+/).map(Number);
  const n = nums[0];
  const values = nums.slice(1);
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const bit = Array(sorted.length + 2).fill(0);
  let inversions = 0n;
  for (let i = 0; i < n; i += 1) {
    const rank = lowerBound(sorted, values[i]) + 1;
    const seenLessOrEqual = bitSum(bit, rank);
    inversions += BigInt(i - seenLessOrEqual);
    bitAdd(bit, rank, 1);
  }
  return `${inversions % 998244353n}\n`;
}

function solveP06(input) {
  const nums = input.trim().split(/\s+/).map(Number);
  let at = 0;
  const n = nums[at++];
  const m = nums[at++];
  const graph = Array.from({ length: n + 1 }, () => []);
  for (let i = 0; i < m; i += 1) {
    const u = nums[at++];
    const v = nums[at++];
    graph[u].push(v);
    graph[v].push(u);
  }
  const seen = Array(n + 1).fill(false);
  for (let start = 1; start <= n; start += 1) {
    if (seen[start]) continue;
    let vertices = 0;
    let degreeSum = 0;
    const stack = [start];
    seen[start] = true;
    while (stack.length) {
      const node = stack.pop();
      vertices += 1;
      degreeSum += graph[node].length;
      for (const next of graph[node]) {
        if (!seen[next]) {
          seen[next] = true;
          stack.push(next);
        }
      }
    }
    if (degreeSum / 2 !== vertices) return 'NO\n';
  }
  return 'YES\n';
}

function solveP07(input) {
  const tokens = input.trim().split(/\s+/);
  let at = 0;
  const n = Number(tokens[at++]);
  const target = tokens[at++];
  const parent = Array(n + 1).fill(0);
  for (let i = 2; i <= n; i += 1) parent[i] = Number(tokens[at++]);
  const labels = [''];
  for (let i = 1; i <= n; i += 1) labels.push(tokens[at++]);
  const children = Array.from({ length: n + 1 }, () => []);
  for (let i = 2; i <= n; i += 1) children[parent[i]].push(i);
  let count = 0;
  function dfs(node, text) {
    const nextText = `${text}${labels[node]}`;
    if (nextText.endsWith(target)) count += 1;
    for (const child of children[node]) dfs(child, nextText);
  }
  dfs(1, '');
  return `${count}\n`;
}

function solveP08(input) {
  const [s, rawK] = input.trim().split(/\s+/);
  const k = Number(rawK);
  let low = 1;
  let high = s.length;
  let ans = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (canCut(s, k, mid)) {
      ans = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return `${ans}\n`;
}

function solveP09(input) {
  const nums = input.trim().split(/\s+/).map(Number);
  let at = 0;
  const n = nums[at++];
  const graph = Array.from({ length: n + 1 }, () => []);
  for (let i = 0; i < n - 1; i += 1) {
    const u = nums[at++];
    const v = nums[at++];
    graph[u].push(v);
    graph[v].push(u);
  }
  const values = nums.slice(at, at + n);
  const position = Array(n);
  for (let i = 0; i < n; i += 1) position[values[i]] = i + 1;
  const parentFromRoot = buildParentTable(graph, n, position[0]);
  const out = [];
  for (let mex = 0; mex < n; mex += 1) {
    const used = Array(n + 1).fill(false);
    for (let value = 0; value <= mex; value += 1) {
      let node = position[value];
      while (node !== 0 && !used[node]) {
        used[node] = true;
        node = parentFromRoot[node];
      }
    }
    out.push(String(used.filter(Boolean).length));
  }
  return `${out.join(' ')}\n`;
}

function solveP10(input) {
  const lines = input.trim().split(/\r?\n/);
  const [n, m, maxTurns] = lines[0].split(/\s+/).map(Number);
  const grid = lines.slice(1, 1 + n);
  const mod = 1_000_000_007;
  const dp = Array.from({ length: n }, () => Array.from({ length: m }, () => Array.from({ length: maxTurns + 1 }, () => [0, 0])));
  if (grid[0][0] === '#') return '0\n';
  if (m > 1 && grid[0][1] === '.') dp[0][1][0][0] = 1;
  if (n > 1 && grid[1][0] === '.') dp[1][0][0][1] = 1;
  if (n === 1 && m === 1) return '1\n';
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < m; j += 1) {
      if (grid[i][j] === '#') continue;
      for (let t = 0; t <= maxTurns; t += 1) {
        for (let dir = 0; dir < 2; dir += 1) {
          const ways = dp[i][j][t][dir];
          if (!ways) continue;
          for (const [nextDir, di, dj] of [[0, 0, 1], [1, 1, 0]]) {
            const ni = i + di;
            const nj = j + dj;
            const nt = t + (nextDir === dir ? 0 : 1);
            if (ni < n && nj < m && nt <= maxTurns && grid[ni][nj] === '.') {
              dp[ni][nj][nt][nextDir] = (dp[ni][nj][nt][nextDir] + ways) % mod;
            }
          }
        }
      }
    }
  }
  let answer = 0;
  for (let t = 0; t <= maxTurns; t += 1) {
    answer = (answer + dp[n - 1][m - 1][t][0] + dp[n - 1][m - 1][t][1]) % mod;
  }
  return `${answer}\n`;
}

function canCut(s, k, length) {
  let count = 0;
  for (let start = 0; start + length <= s.length;) {
    const seen = new Set();
    let ok = true;
    for (let i = start; i < start + length; i += 1) {
      if (seen.has(s[i])) {
        ok = false;
        break;
      }
      seen.add(s[i]);
    }
    if (ok) {
      count += 1;
      start += length;
    } else {
      start += 1;
    }
  }
  return count >= k;
}

function minOperationCount(c, a, b) {
  if (c === 0n) return 0n;
  if (a === 0n && b === 0n) return -1n;
  if (a === 0n) return c % b === 0n ? c / b : -1n;
  if (b === 0n) return c % a === 0n ? c / a : -1n;
  const big = a >= b ? a : b;
  const small = a >= b ? b : a;
  if (big === small) return c % big === 0n ? c / big : -1n;

  const g = gcd(big, small);
  if (c % g !== 0n) return -1n;
  const bigUnit = big / g;
  const smallUnit = small / g;
  const target = c / g;
  const firstBigCount = smallUnit === 1n
    ? 0n
    : (target % smallUnit) * modInv(bigUnit % smallUnit, smallUnit) % smallUnit;
  const maxBigCount = target / bigUnit;
  if (firstBigCount > maxBigCount) return -1n;
  const bigCount = firstBigCount + ((maxBigCount - firstBigCount) / smallUnit) * smallUnit;
  const smallCount = (target - bigUnit * bigCount) / smallUnit;
  return bigCount + smallCount;
}

function buildParentTable(graph, n, root) {
  const parent = Array(n + 1).fill(0);
  const queue = [root];
  parent[root] = 0;
  const seen = Array(n + 1).fill(false);
  seen[root] = true;
  for (let qi = 0; qi < queue.length; qi += 1) {
    const node = queue[qi];
    for (const next of graph[node]) {
      if (!seen[next]) {
        seen[next] = true;
        parent[next] = node;
        queue.push(next);
      }
    }
  }
  return parent;
}

function gcd(a, b) {
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a < 0n ? -a : a;
}

function egcd(a, b) {
  if (b === 0n) return [a, 1n, 0n];
  const [g, x1, y1] = egcd(b, a % b);
  return [g, y1, x1 - (a / b) * y1];
}

function modInv(a, mod) {
  if (mod === 1n) return 0n;
  const [g, x] = egcd(a, mod);
  if (g !== 1n) return 0n;
  return ((x % mod) + mod) % mod;
}

function sqrtBigInt(value) {
  if (value < 2n) return value;
  let low = 1n;
  let high = value;
  while (low <= high) {
    const mid = (low + high) >> 1n;
    const sq = mid * mid;
    if (sq === value) return mid;
    if (sq < value) low = mid + 1n;
    else high = mid - 1n;
  }
  return high;
}

function upperBound(arr, value) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (arr[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function lowerBound(arr, value) {
  let low = 0;
  let high = arr.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (arr[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

function bitAdd(bit, index, delta) {
  for (let i = index; i < bit.length; i += i & -i) bit[i] += delta;
}

function bitSum(bit, index) {
  let sum = 0;
  for (let i = index; i > 0; i -= i & -i) sum += bit[i];
  return sum;
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

function shuffle(values, rng) {
  const next = [...values];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = randInt(rng, 0, i);
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
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
  console.error('Usage: node judge.mjs <practice|final> <all|p01..p10>');
  process.exit(2);
}

function main() {
  if (!['practice', 'final'].includes(mode)) {
    failUsage();
  }
  if (requestedProblem !== 'all' && !problems.includes(requestedProblem)) {
    failUsage();
  }

  const selected = requestedProblem === 'all' ? problems : [requestedProblem];
  const results = selected.map((problem) => judgeProblem(problem, mode));
  const solved = results.filter((result) => result.passed).length;

  if (mode === 'practice') {
    if (results.every((result) => result.passed)) {
      console.log('PASS');
      process.exit(0);
    }
    console.log('FAIL');
    process.exit(1);
  }

  for (const result of results) {
    console.log(`${result.problem} ${result.passed ? 'PASS' : 'FAIL'} ${result.passedCount}/${result.totalCount}`);
  }
  console.log(`SOLVED ${solved}/${selected.length}`);
  process.exit(results.every((result) => result.passed) ? 0 : 1);
}

main();
