/**
 * Accuracy sweep: many shapes of real command output, each hiding one fact the
 * agent would need next. Scores whether that fact survived pruning, how much
 * went away, and whether output meant to pass through was left alone.
 */
import { trimOutput } from '../../src/output.js';
import { jevAsker } from '../../hooks/fast-jev-output.js';

const apiKey = process.env.TYPESAFE_API_KEY ?? process.env.EVAL_TYPESAFE_API_KEY;
if (!apiKey) throw new Error('set TYPESAFE_API_KEY');
const asker = jevAsker(async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  return { status: r.status, ok: r.ok, text: await r.text() };
}, apiKey, 'jev-latest');

const lines = (n: number, make: (i: number) => string) => Array.from({ length: n }, (_, i) => make(i));
const place = (rows: string[], where: 'start' | 'mid' | 'end', needle: string) => {
  const at = where === 'start' ? Math.floor(rows.length * 0.04) : where === 'mid' ? Math.floor(rows.length * 0.5) : rows.length - 3;
  const copy = [...rows];
  copy[at] = needle;
  return copy.join('\n');
};

type Case = { name: string; command: string; goal: string; rows: string[]; needle: string; key: string; where?: 'start' | 'mid' | 'end'; expect?: 'trim' | 'skip' };
const CASES: Case[] = [
  { name: 'pytest failure', command: 'python3 -m pytest -q', goal: 'Get the suite green.',
    rows: lines(400, (i) => `tests/test_mod_${i}.py::test_case_${i} PASSED   [ ${i % 100}%]`),
    needle: 'FAILED tests/test_checkout.py::test_discount - AssertionError: assert 7 == 10', key: 'test_discount' },
  { name: 'npm audit count', command: 'npm install', goal: 'Install and report vulnerabilities.',
    rows: lines(400, (i) => `npm http fetch GET 200 https://registry.npmjs.org/pkg-${i} 1${i % 9}ms`),
    needle: '7 high severity vulnerabilities found in 903 packages', key: '7 high severity' },
  { name: 'docker layer error', command: 'docker build .', goal: 'Get the image building.',
    rows: lines(400, (i) => `#${i} sha256:${'b'.repeat(10)}${i} extracting layer ${i} done`),
    needle: '#402 ERROR: failed to solve: could not find a version satisfying pandas==99.9', key: 'pandas==99.9' },
  { name: 'java stack trace', command: './gradlew test', goal: 'Diagnose the test crash.',
    rows: lines(500, (i) => `[INFO] running com.acme.Suite${i}#case${i} in ${i % 300}ms`),
    needle: 'Caused by: java.lang.NullPointerException at com.acme.CartService.total(CartService.java:88)', key: 'CartService.java:88' },
  { name: 'terraform change', command: 'terraform plan', goal: 'Check what the plan changes.',
    rows: lines(400, (i) => `  # module.svc_${i}.aws_instance.node will not change`),
    needle: '  # module.db.aws_db_instance.primary must be REPLACED (forces replacement: engine_version)', key: 'must be REPLACED' },
  { name: 'kubectl not ready', command: 'kubectl get pods -A', goal: 'Find unhealthy pods.',
    rows: lines(400, (i) => `default   svc-${i}-abc   1/1   Running   0   ${i}h`),
    needle: 'payments   checkout-77-xyz   0/1   CrashLoopBackOff   14   22m', key: 'CrashLoopBackOff' },
  { name: 'git log commit', command: 'git log --oneline -n 400', goal: 'Find the commit that changed the tax rate.',
    rows: lines(400, (i) => `${(0x100000 + i).toString(16)} chore: routine change ${i}`),
    needle: 'a91f3cd fix(tax): raise Austin rate to 0.0825 for CHK-2291', key: 'CHK-2291' },
  { name: 'grep hit', command: "grep -rn 'TODO' src/", goal: 'Find the TODO about coupons.',
    rows: lines(400, (i) => `src/mod_${i}/file.py:${i}:# TODO: tidy later`),
    needle: 'src/checkout/parser.py:88:# TODO(priya): percentage coupons unsupported', key: 'percentage coupons' },
  { name: 'ps memory hog', command: 'ps aux', goal: 'Find what is eating memory.',
    rows: lines(400, (i) => `root ${1000 + i}  0.1  0.2 123456 4321 ??  S  9:0${i % 9}AM   0:0${i % 9}.12 /usr/bin/helper-${i}`),
    needle: 'app  8931 98.4 71.2 9812345 5991234 ??  R  3:14AM 412:09.77 /usr/bin/checkout-worker --pool=4', key: '71.2' },
  { name: 'curl 500', command: 'curl -v https://api.internal/checkout', goal: 'Find why the request failed.',
    rows: lines(300, (i) => `* header line ${i}: x-trace-${i}: ${'0'.repeat(8)}${i}`),
    needle: '< HTTP/2 500 x-request-id: 482913377 upstream: checkout-v2 timeout after 30s', key: '482913377' },
  { name: 'du big dir', command: 'du -sh *', goal: 'Find what is filling the disk.',
    rows: lines(400, (i) => `${i % 90}K\tdir_${i}`),
    needle: '48G\tnode_modules/.cache/turbo', key: '48G' },
  { name: 'tar listing', command: 'tar -tvf release.tar', goal: 'Check the archive holds the signed binary.',
    rows: lines(400, (i) => `-rw-r--r--  0 build  staff  ${i * 13} Sep 18 10:0${i % 9} release/asset_${i}.txt`),
    needle: '-rwxr-xr-x  0 build  staff  8812345 Sep 18 10:44 release/bin/checkout-signed', key: 'checkout-signed' },
  { name: 'all relevant (skip)', command: 'git log --oneline -n 40', goal: 'Summarize every commit for release notes.',
    rows: lines(40, (i) => `${(0x200000 + i).toString(16)} feat: change ${i} to the parser`),
    needle: `${(0x200000).toString(16)} feat: change 0 to the parser`, key: 'feat: change', expect: 'skip' },
];

const runs = Number(process.env.RUNS ?? 1);
const positions: Array<'start' | 'mid' | 'end'> = ['start', 'mid', 'end'];
let kept = 0, total = 0, reductions: number[] = [], wrong = 0, skipRuns = 0;
for (const testCase of CASES) {
  for (const where of testCase.expect === 'skip' ? (['mid'] as const) : positions) {
    for (let run = 0; run < runs; run += 1) {
      const output = place(testCase.rows, where, testCase.needle);
      const r = await trimOutput(
        { command: testCase.command, goal: testCase.goal, output, fullOutputPath: '/saved.txt' },
        asker,
        { maxChars: 8_000 },
      );
      const survived = r.output.includes(testCase.key);
      if (testCase.expect === 'skip') {
        skipRuns += 1;
        if (r.trimmed) wrong += 1;
      } else {
        total += 1;
        if (survived) kept += 1;
        reductions.push(100 * (r.charsBefore - r.charsAfter) / r.charsBefore);
        if (!survived) console.log(`  LOST  ${testCase.name} (${where}): ${r.charsBefore}->${r.charsAfter}`);
      }
    }
  }
  process.stdout.write(`${testCase.name.padEnd(22)} done\n`);
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log(`\nneedle retention  ${kept}/${total} (${(100 * kept / total).toFixed(1)}%)`);
console.log(`mean reduction    ${mean(reductions).toFixed(0)}%`);
console.log(`wrongly trimmed   ${wrong}/${skipRuns} pass-through runs`);
