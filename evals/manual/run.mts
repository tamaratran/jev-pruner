/**
 * Manual eval: calls the pruning code directly against live Jev, so a sweep
 * costs cents and seconds. Each scenario carries a needle the agent would need
 * afterwards; the score is whether the needle survived and how much went away.
 */
import { trimOutput } from '../../src/output.js';
import { jevAsker } from '../../hooks/fast-jev-output.js';

const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.EVAL_TYPESAFE_API_KEY;
if (!apiKey) throw new Error('set TYPESAFE_API_KEY');
const asker = jevAsker(async (url, init) => {
  const response = await fetch(url, init as RequestInit);
  return { status: response.status, ok: response.ok, text: await response.text() };
}, apiKey, process.env.JEV_MODEL ?? 'jev-latest');

const lines = (n: number, make: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => make(i)).join('\n');

type Case = {
  name: string;
  command: string;
  goal: string;
  output: string;
  /** Text that must survive; empty means the whole output should pass through. */
  needles: string[];
  expect: 'trim' | 'skip';
};

const CASES: Case[] = [
  {
    name: 'build-error',
    command: 'npm run build',
    goal: 'Fix the failing build.',
    output: lines(320, (i) =>
      i === 180
        ? 'ERROR worker-3 failed to link checkout_v2: undefined symbol parse_coupon_v2 (exit 1)'
        : `[${i}] compiled module ${i} in ${i % 400}ms`),
    needles: ['parse_coupon_v2'],
    expect: 'trim',
  },
  {
    name: 'test-summary',
    command: 'python3 -m pytest -q',
    goal: 'Get the test suite green.',
    output: `${lines(300, (i) => `tests/test_module_${i}.py::test_case_${i} PASSED   [ ${i % 100}%]`)}\nFAILED tests/test_checkout.py::test_discount - AssertionError: assert 7 == 10\n1 failed, 300 passed in 12.44s`,
    needles: ['test_discount', '1 failed, 300 passed'],
    expect: 'trim',
  },
  {
    name: 'install-summary',
    command: 'npm install',
    goal: 'Install dependencies and report what changed.',
    output: `${lines(260, (i) => `npm http fetch GET 200 https://registry.npmjs.org/package-${i} 1${i % 9}ms (cache revalidated)`)}\nadded 214 packages, and audited 903 packages in 47s\n3 moderate severity vulnerabilities`,
    needles: ['added 214 packages', '3 moderate severity'],
    expect: 'trim',
  },
  {
    name: 'needle-detail',
    command: 'tail -n +1 inventory.txt',
    goal: 'Find the serial number recorded for item-177.',
    output: lines(300, (i) =>
      i === 177
        ? 'item-177 qty=13 bin=Z9 serial=SN-88431-XQ status=quarantined'
        : `item-${i} qty=${i % 50} bin=A${i % 20} status=in-stock`),
    needles: ['SN-88431-XQ'],
    expect: 'trim',
  },
  {
    name: 'two-outliers',
    command: 'tail -n +1 latency.log',
    goal: 'Report the two slowest requests.',
    output: lines(300, (i) =>
      i === 44 ? 'INFO worker-5 request 44 latency=1840ms'
      : i === 255 ? 'INFO worker-2 request 255 latency=1795ms'
      : `INFO worker-${i % 7} request ${i} latency=${(i * 3) % 900}ms`),
    needles: ['1840ms', '1795ms'],
    expect: 'trim',
  },
  {
    name: 'stack-trace',
    command: 'node server.js',
    goal: 'Diagnose the crash.',
    output: `${lines(200, (i) => `${new Date(Date.UTC(2026, 8, 18, 10, i % 60)).toISOString()} INFO request ${i} served in ${i % 90}ms`)}\nTypeError: Cannot read properties of undefined (reading 'discount')\n    at lineTotal (/srv/checkout/parser.js:42:31)\n    at /srv/checkout/parser.js:58:19\n${lines(120, (i) => `2026-09-18 INFO retry ${i} queued`)}`,
    needles: ["reading 'discount'", 'parser.js:42'],
    expect: 'trim',
  },
  {
    name: 'grep-hits',
    command: "grep -rn 'TODO' src/",
    goal: 'List the TODOs that mention the parser.',
    output: lines(280, (i) =>
      i === 149
        ? 'src/checkout/parser.py:88:# TODO(priya): parser cannot handle percentage coupons yet'
        : `src/module_${i}/file_${i}.py:${i}:# TODO: tidy this later`),
    needles: ['percentage coupons'],
    expect: 'trim',
  },
  {
    name: 'docker-build',
    command: 'docker build .',
    goal: 'Get the image to build.',
    output: `${lines(240, (i) => `#${i} sha256:${'a'.repeat(12)}${i} extracting layer ${i} done`)}\n#241 ERROR: failed to solve: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully: exit code 1\n#241 ERROR: Could not find a version that satisfies the requirement pandas==99.9`,
    needles: ['did not complete successfully', 'pandas==99.9'],
    expect: 'trim',
  },
  {
    name: 'all-relevant',
    command: 'git log --oneline -n 40',
    goal: 'Summarize every commit on this branch for the release notes.',
    output: lines(40, (i) => `${(1000000 + i).toString(16)} fix(checkout): change ${i} to the parser`),
    needles: [],
    expect: 'skip',
  },
  {
    name: 'json-doc',
    command: 'tail -n +1 services.json',
    goal: 'Find which team owns svc-77.',
    output: JSON.stringify(
      { services: Array.from({ length: 120 }, (_, i) => ({ id: i, name: `svc-${i}`, owner: i === 77 ? 'payments-team' : 'infra' })) },
      null,
      2,
    ),
    needles: [],
    expect: 'skip',
  },
  {
    name: 'binary',
    command: 'tail -n +1 logo.png',
    goal: 'Check the file.',
    output: Array.from({ length: 9000 }, (_, i) => String.fromCharCode(i % 256)).join(''),
    needles: [],
    expect: 'skip',
  },
  {
    name: 'short',
    command: 'git status --short',
    goal: 'Check the working tree.',
    output: lines(20, (i) => ` M src/file_${i}.ts`),
    needles: [],
    expect: 'skip',
  },
];

const runs = Number(process.env.RUNS ?? 3);
type Row = { name: string; expect: string; trimmed: number; reduction: number[]; kept: number; ms: number[]; needle: number; total: number };
const rows: Row[] = [];

for (const testCase of CASES) {
  const row: Row = { name: testCase.name, expect: testCase.expect, trimmed: 0, reduction: [], kept: 0, ms: [], needle: 0, total: runs };
  for (let run = 0; run < runs; run += 1) {
    const started = Date.now();
    let result;
    try {
      result = await trimOutput(
        { command: testCase.command, goal: testCase.goal, output: testCase.output, fullOutputPath: '.claude/x.txt' },
        asker,
      );
    } catch (error) {
      console.log(`  ${testCase.name} run ${run + 1} threw: ${(error as Error).message}`);
      continue;
    }
    row.ms.push(Date.now() - started);
    if (result.trimmed) row.trimmed += 1;
    row.reduction.push(100 * (result.charsBefore - result.charsAfter) / result.charsBefore);
    row.kept += result.chunks > 0 ? result.kept / result.chunks : 1;
    const survived = testCase.needles.every((needle) => result.output.includes(needle));
    if (survived) row.needle += 1;
  }
  rows.push(row);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  console.log(
    `${testCase.name.padEnd(16)} expect=${testCase.expect.padEnd(4)} trimmed ${row.trimmed}/${runs}  reduction ${mean(row.reduction).toFixed(0).padStart(3)}%  needles kept ${row.needle}/${runs}  ${mean(row.ms).toFixed(0)}ms`,
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const trimCases = rows.filter((r) => r.expect === 'trim');
const skipCases = rows.filter((r) => r.expect === 'skip');
console.log(`\nneedle retention   ${trimCases.reduce((s, r) => s + r.needle, 0)}/${trimCases.reduce((s, r) => s + r.total, 0)}`);
console.log(`mean reduction     ${mean(trimCases.flatMap((r) => r.reduction)).toFixed(0)}% on cases meant to trim`);
console.log(`wrongly trimmed    ${skipCases.reduce((s, r) => s + r.trimmed, 0)}/${skipCases.reduce((s, r) => s + r.total, 0)} of the pass-through cases`);
console.log(`mean latency       ${mean(rows.flatMap((r) => r.ms)).toFixed(0)}ms`);
