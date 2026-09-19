import { describe, expect, it, vi } from 'vitest';
import { classifyOutput, trimOutput } from '../src/output.js';
import { estimateStateTokens, estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';

const noise = Array.from({ length: 200 }, (_, i) => `${i}: ${'cached unchanged '.repeat(30)}`).join('\n');
const dropAll = async (_state: JevState, questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
});

describe('output categories', () => {
  it.each([
    'npm run build', 'npm test -- --verbose', 'npm ci', 'npm install',
    'pnpm run test:unit', 'pnpm build', 'yarn install', 'bun test',
    'CI=true npm run build', 'LABEL="local build" npm test',
    '/usr/local/bin/npm run build', './node_modules/.bin/vitest run',
    'make -j4', 'ninja', 'cmake --build build', 'pytest -v',
    'python3 -m pytest', 'python3.12 -m unittest', 'python -m pip install .',
    'uv pip install -r requirements.txt', 'cargo test', 'go build ./...',
    './gradlew test', 'mvn test',
  ])('recognizes build, install, or test logs: %s', command => {
    expect(classifyOutput(command, noise)).toBe('build');
  });

  it.each([
    'rg -n auth src', 'grep -R "user name" src', 'git grep auth',
    'find src -name "*.ts"', 'fd config', 'head -n 300 app.ts',
    'tail -n 500 build.log', "sed -n '1,500p' app.ts", '/usr/bin/grep auth app.ts',
  ])('recognizes search results and excerpts: %s', command => {
    expect(classifyOutput(command, noise)).toBe('search');
  });

  it.each([
    'custom-check', 'npm run publish', 'npm run rebuild', 'npm view package',
    'echo npm test', 'printf "rg auth src"', 'bash -c "npm test"',
    'npm test && rg auth src', 'rg auth src | sort', 'npm test\nrg auth src',
    'npm test > results.txt', 'echo $(npm test)', 'env -i npm test',
    'cd app && npm test', 'npm exec custom-script',
  ])('uses general guidance for unknown or complex commands: %s', command => {
    expect(classifyOutput(command, noise)).toBe('unknown');
  });

  it.each([
    'cat file.txt', ' bat file.txt', 'jq . file.json', 'yq . file.yaml',
    'git diff', 'git show HEAD', 'base64 data', 'openssl x509 -in cert.pem',
    '/usr/bin/cat file.txt', 'LANG=C /usr/bin/diff a b',
    'cd app && cat file.txt', 'npm test | jq .',
  ])('preserves whole-document commands: %s', async command => {
    const ask = vi.fn(dropAll);
    expect(estimateTokens(noise)).toBeGreaterThan(10_000);
    expect(classifyOutput(command, noise)).toBe('document');
    const result = await trimOutput({ command, goal: '', output: noise }, { ask });
    expect(result.output).toBe(noise);
    expect(result.trimmed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    JSON.stringify({ items: noise.split('\n') }),
    JSON.stringify(noise.split('\n')),
    `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n${noise}`,
    `<?xml version="1.0"?><log>${noise}</log>`,
    `---\nlog: |\n${noise}`,
  ])('gives output format precedence over a build command', async output => {
    const ask = vi.fn(dropAll);
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    expect(classifyOutput('npm run build', output)).toBe('document');
    const result = await trimOutput({ command: 'npm run build', goal: '', output }, { ask });
    expect(result.output).toBe(output);
    expect(ask).not.toHaveBeenCalled();
  });

  it('does not mistake bracketed log messages for a JSON document', () => {
    expect(classifyOutput('npm test', `[test] started\n${noise}`)).toBe('build');
  });
});

describe('category scoring state', () => {
  it.each([
    ['npm run build', 'build', 8_000],
    ['rg auth src', 'search', 8_000],
    ['npm run build', 'build', 20_000],
    ['rg auth src', 'search', 20_000],
  ] as const)('preserves %s (%s) guidance with a %i-character budget', async (command, category, maxChars) => {
    const onDecision = vi.fn();
    const ask = vi.fn(async (_state: JevState, questions: JevQuestions) => ({
      answers: Object.fromEntries(Object.keys(questions).map(id => [
        id, { noul: id.startsWith('c') ? 0.9 : 0.1 },
      ])),
    }));
    const result = await trimOutput(
      { command, goal: 'Keep relevant evidence.', output: noise },
      { ask },
      { maxChars, onDecision },
    );
    expect(ask.mock.calls.some(([, questions]) => Object.keys(questions).some(id => id.startsWith('g')))).toBe(true);
    for (const [state] of ask.mock.calls) {
      expect(state).toMatchObject({ category, categoryGuidance: expect.any(String) });
      expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(25_000);
    }
    expect(result.trimmed).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(maxChars);
    expect(onDecision).toHaveBeenCalledWith('pruned');
  });

  it.each([
    ['npm run build', 'build', 'artifact paths'],
    ['rg auth src', 'search', 'repetition alone does not make a match disposable'],
  ])('sends %s guidance in every bounded history/output request', async (command, category, guidance) => {
    const ask = vi.fn(dropAll);
    const output = noise.replace('100:', 'ERROR: required diagnostic');
    const result = await trimOutput({
      command, goal: 'Investigate the problem.', output,
      messages: [{
        role: 'user', text: '', toolUses: [],
        toolResults: [{ tool_use_id: 'prior', text: 'prior evidence '.repeat(2_000) }],
      }],
    }, { ask }, { maxStateTokens: 4_000, chunkLines: 10, maxScoringRequests: 200 });
    expect(ask.mock.calls.length).toBeGreaterThan(1);
    expect(ask.mock.calls.length).toBeLessThanOrEqual(201);
    const histories = new Set<string>();
    for (const [state, questions] of ask.mock.calls) {
      expect(state).toMatchObject({ category, categoryGuidance: expect.stringContaining(guidance) });
      expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(4_000);
      expect(estimateStateTokens(JSON.stringify({ state, questions }))).toBeLessThanOrEqual(30_000);
      histories.add(JSON.stringify((state as { history: unknown }).history));
    }
    expect(histories.size).toBeGreaterThan(1);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain('ERROR: required diagnostic');
    expect(result.output).toContain(noise.split('\n')[0]);
    expect(result.output).toContain(noise.split('\n').at(-1));
  });

  it('leaves unknown-command state and retention questions unchanged', async () => {
    const ask = vi.fn(dropAll);
    await trimOutput({ command: 'custom-command', goal: 'g', output: noise }, { ask });
    const [generalState, generalQuestions] = ask.mock.calls[0]!;
    expect(generalState).not.toHaveProperty('category');
    expect(generalState).not.toHaveProperty('categoryGuidance');
    ask.mockClear();
    await trimOutput({ command: 'npm test', goal: 'g', output: noise }, { ask });
    const [buildState, buildQuestions] = ask.mock.calls[0]!;
    expect(buildQuestions).toEqual(generalQuestions);
    expect((buildState as { context: string }).context).toBe((generalState as { context: string }).context);
  });

  it.each(['npm test', 'rg auth src', 'custom-command'])('keeps the strict token gate for %s', async command => {
    const ask = vi.fn(dropAll);
    const output = Array(10_000).fill('cache').join('\n');
    expect(estimateTokens(output)).toBe(10_000);
    expect((await trimOutput({ command, goal: '', output }, { ask })).output).toBe(output);
    expect(ask).not.toHaveBeenCalled();
    expect((await trimOutput({ command, goal: '', output: `${output}\ncache` }, { ask })).trimmed).toBe(true);
    expect(ask).toHaveBeenCalled();
  });
});
