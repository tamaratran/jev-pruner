/**
 * Accuracy on real command output captured from this machine, not synthetic
 * logs: each file is the stdout of a command someone would actually run, and
 * the needle is the line an agent would need from it next.
 */
import { readFileSync } from 'node:fs';
import { trimOutput } from '../../src/output.js';
import { jevAsker } from '../../hooks/fast-jev-output.js';

const dir = process.env.REAL_DIR!;
const apiKey = process.env.TYPESAFE_API_KEY!;
const asker = jevAsker(async (url, init) => {
  const r = await fetch(url, init as RequestInit);
  return { status: r.status, ok: r.ok, text: await r.text() };
}, apiKey, 'jev-latest');

type Case = { file: string; command: string; goal: string; keys: string[] };
const CASES: Case[] = [
  { file: 'pytest.txt', command: 'python3 -m pytest -v', goal: 'Find which tests fail and why.', keys: ['FAILED tests/test_parser.py::test_basic'] },
  { file: 'vitest.txt', command: 'npx vitest run --reporter verbose', goal: 'Report whether the suite passed and how many tests ran.', keys: ['45 passed'] },
  { file: 'tsc.txt', command: 'npx tsc --noEmit -p tsconfig.json --listFiles', goal: 'Find the type error and the file it is in.', keys: ['error TS2322'] },
  { file: 'npmls.txt', command: 'npm ls --all', goal: 'Find which version of express is installed.', keys: ['express@5.2.1'] },
  { file: 'gitlog.txt', command: 'git log --stat -n 40', goal: 'Find the commit that made the budget a hard cap.', keys: ['hard cap'] },
  { file: 'find.txt', command: 'find node_modules -name "*.d.ts"', goal: 'Check whether vitest ships its own type declarations entrypoint.', keys: ['vitest/dist/index.d.ts'] },
  { file: 'du.txt', command: 'du -a node_modules | sort -rn | head -2000', goal: 'Find the largest directory in node_modules.', keys: ['typescript'] },
  { file: 'lsr.txt', command: 'ls -laR node_modules/vitest', goal: 'Check what vitest ships in its dist directory.', keys: ['dist'] },
  { file: 'curl.txt', command: 'curl -s -D - https://api.github.com/rate_limit; curl -s -D - https://example.com (x60)', goal: 'Find how much GitHub API rate limit is left.', keys: ['x-ratelimit-remaining'] },
  { file: 'docker.txt', command: 'docker images -a; docker ps -a', goal: 'Check what images and containers exist.', keys: ['REPOSITORY'] },
];

const runs = Number(process.env.RUNS ?? 1);
let kept = 0, total = 0; const reductions: number[] = [];
for (const c of CASES) {
  const output = readFileSync(`${dir}/${c.file}`, 'utf8');
  for (let i = 0; i < runs; i += 1) {
    const r = await trimOutput({ command: c.command, goal: c.goal, output, fullOutputPath: '/saved.txt' }, asker, { maxChars: 8_000 });
    const survived = c.keys.every((k) => !k || r.output.includes(k));
    total += 1; if (survived) kept += 1;
    reductions.push(100 * (r.charsBefore - r.charsAfter) / r.charsBefore);
    console.log(`${c.file.padEnd(13)} ${String(output.length).padStart(7)} -> ${String(r.charsAfter).padStart(6)} chars  ${r.trimmed ? 'trimmed' : 'passed through'}  needle ${survived ? 'kept' : 'LOST'}`);
  }
}
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
console.log(`\nreal-output retention ${kept}/${total}, mean reduction ${mean(reductions).toFixed(0)}%`);
