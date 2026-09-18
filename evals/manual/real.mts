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
  { file: 'npm.txt', command: 'npm install --loglevel verbose express lodash vitest', goal: 'Install the dependencies and report what was added.', keys: ['added'] },
  { file: 'gitlog.txt', command: 'git log --stat -n 60', goal: 'Find which commit added the manual eval and what it touched.', keys: ['manual eval'] },
  { file: 'gitdiff.txt', command: 'git log -p -n 8', goal: 'Find the change that made the budget keep error chunks.', keys: ['ERROR_PATTERN'] },
  { file: 'lsr.txt', command: 'ls -laR node_modules', goal: 'Check whether vitest is installed and what is in its dist directory.', keys: ['vitest'] },
  { file: 'du.txt', command: 'du -a node_modules | sort -n | tail -3000', goal: 'Find the biggest thing in node_modules.', keys: ['node_modules\n', 'typescript'] },
  { file: 'grep.txt', command: 'grep -rn "export" node_modules/vitest/dist', goal: 'Find where vitest exports its public API.', keys: ['index.js'] },
  { file: 'find.txt', command: 'find node_modules -type f -name "*.js"', goal: 'Check whether esbuild ships a js entrypoint.', keys: ['esbuild'] },
  { file: 'vitest2.txt', command: 'npx vitest run --reporter verbose --reporter=json', goal: 'Report whether the suite passed and how many tests ran.', keys: ['passed'] },
  { file: 'pip.txt', command: 'pip list; brew list --versions', goal: 'Check which python and brew packages are installed.', keys: [''] },
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
