import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevAsker } from '../../hooks/fast-jev-output.js';
import { estimateTokens } from '../../src/jev.js';
import { trimOutput } from '../../src/output.js';
import type { TrimDecision } from '../../src/output.js';
import { classifyInformation } from '../../src/retention.js';

interface Fixture {
  name: string;
  goal: string;
  output: string;
  required: string[];
  preserveWhole: boolean;
}

const rows = (make: (index: number) => string) => Array.from({ length: 1800 }, (_, index) => make(index));
const cache = rows(index => `progress: cache entry ${index} already current; ${'unchanged '.repeat(5)}`);
cache[850] = 'ERROR: deployment blocked because the release directory is not writable.';
cache[1799] = 'Build failed. Exit status: 1';
const install = rows(index => `npm http fetch GET 200 https://registry.npmjs.org/package-${index} 12ms (cache hit)`);
install[850] = '7 high severity vulnerabilities found in 903 packages';
install[1799] = 'Summary: added 903 packages in 21 seconds';
const tests = rows(index => `tests/test_module_${index}.py::test_case_${index} PASSED [${index % 100}%]`);
tests[850] = 'FAILED tests/test_checkout.py::test_discount - AssertionError: assert 7 == 10';
tests[1799] = 'Tests: 1799 passed, 1 failed';
const docs = rows(index => `Option ${index}: configure the service with an explicit timeout and preserve the existing environment defaults.`);
docs[0] = '# Deployment reference';
docs[850] = 'For the payments service, set REQUEST_TIMEOUT_MS=4700 before deployment.';
const assembly = rows(index => `  ${(0x400000 + index * 4).toString(16)}: 48 89 c0 mov %rax,%rax`);
assembly[850] = '  400d48: 48 83 c0 2a add $0x2a,%rax';
const source = rows(index => `export const service_${index} = { timeout: 3000, retryCount: 2, enabled: true };`);
source[850] = 'export const paymentPolicy = { timeout: 4700, retryCount: 5, enabled: true };';

const fixtures: Fixture[] = [
  { name: 'cache-build', goal: 'Report the deployment blocker and exit status.', output: cache.join('\n'),
    required: ['release directory is not writable', 'Exit status: 1'], preserveWhole: false },
  { name: 'npm-install', goal: 'Report the severity and number of vulnerabilities, installed package count and elapsed time.', output: install.join('\n'),
    required: ['7 high severity', 'added 903 packages in 21 seconds'], preserveWhole: false },
  { name: 'pytest', goal: 'Report the failing test, assertion and final test totals.', output: tests.join('\n'),
    required: ['test_discount', 'assert 7 == 10', '1799 passed, 1 failed'], preserveWhole: false },
  { name: 'documentation', goal: 'Find the payments service deployment timeout and keep the reference available for follow-up questions.', output: docs.join('\n'),
    required: ['REQUEST_TIMEOUT_MS=4700'], preserveWhole: true },
  { name: 'assembly', goal: 'Identify the instruction at address 400d48 and keep the disassembly available for further analysis.', output: assembly.join('\n'),
    required: ['400d48: 48 83 c0 2a add $0x2a,%rax'], preserveWhole: true },
  { name: 'source', goal: 'Report paymentPolicy timeout and retryCount and keep the source available for further analysis.', output: source.join('\n'),
    required: ['paymentPolicy = { timeout: 4700, retryCount: 5'], preserveWhole: true },
];

const [mode, destination] = process.argv.slice(2);
if (mode === '--emit') {
  const fixture = fixtures.find(item => item.name === destination);
  if (!fixture) throw new Error(`Choose one of: ${fixtures.map(item => item.name).join(', ')}`);
  console.log(fixture.output);
} else {
  if (mode !== '--run' || !destination || !isAbsolute(destination)) {
    throw new Error('Usage: tsx evals/manual/retention.mts --run /new/evidence/directory | --emit NAME');
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error('Set TYPESAFE_API_KEY');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const evidence = resolve(destination);
  if (evidence === resolve(repo) || evidence.startsWith(`${resolve(repo)}/`)) {
    throw new Error('Keep evidence outside the repository');
  }
  mkdirSync(evidence);
  const budgets = [1900, 8000];
  const repetitions = 3;
  writeFileSync(join(evidence, 'protocol.json'), JSON.stringify({
    declaredAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    command: 'python3 /fixture/emit.py',
    budgets, repetitions,
    purpose: 'Exploratory synthetic live-Jev retention preflight; not Claude usage or Terminal-Bench scores.',
    budgetNote: '1900 approximates room inside the observed 2125-character native preview after its archive footer; 8000 diagnoses the effect of a looser cap. Neither changes production settings.',
    fixtures: fixtures.map(fixture => ({
      ...fixture, output: undefined,
      category: classifyInformation(fixture.output),
      estimatedTokens: estimateTokens(fixture.output),
      sourceChars: fixture.output.length,
      sha256: createHash('sha256').update(fixture.output).digest('hex'),
    })),
  }, null, 2));
  for (const fixture of fixtures) {
    if (estimateTokens(fixture.output) <= 10_000) throw new Error(`Below threshold: ${fixture.name}`);
    writeFileSync(join(evidence, `${fixture.name}.txt`), fixture.output);
  }
  for (const fixture of fixtures) {
    for (const maxChars of budgets) {
      for (let repetition = 1; repetition <= repetitions; repetition += 1) {
        const responses: { status: number; elapsedMs: number; body: unknown }[] = [];
        const asker = jevAsker(async (url, init) => {
          const started = performance.now();
          const response = await fetch(url, { ...init as RequestInit, signal: AbortSignal.timeout(30_000) });
          const text = await response.text();
          responses.push({ status: response.status, elapsedMs: performance.now() - started, body: JSON.parse(text) });
          return { status: response.status, ok: response.ok, text };
        }, apiKey, 'jev-latest');
        let decision: TrimDecision | undefined;
        const started = performance.now();
        const result = await trimOutput({
          command: 'python3 /fixture/emit.py', goal: fixture.goal,
          output: fixture.output, fullOutputPath: '/logs/full-output.txt',
        }, asker, { maxChars, onDecision: reason => { decision = reason; } });
        const summary = {
          name: fixture.name, maxChars, repetition, decision,
          elapsedMs: performance.now() - started,
          trimmed: result.trimmed, before: result.charsBefore, after: result.charsAfter,
          allRequiredPresent: fixture.required.every(value => result.output.includes(value)),
          unchanged: result.output === fixture.output,
          preserveWhole: fixture.preserveWhole,
          requests: responses.length,
        };
        const name = `${fixture.name}-${maxChars}-${repetition}`;
        writeFileSync(join(evidence, `${name}.json`), JSON.stringify({ ...summary, scores: result.scores, responses }, null, 2));
        writeFileSync(join(evidence, `${name}-output.txt`), result.output);
        console.log(JSON.stringify(summary));
      }
    }
  }
}
