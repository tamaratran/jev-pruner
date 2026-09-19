import { describe, expect, it, vi } from 'vitest';
import { classifyInformation } from '../src/retention.js';
import { trimOutput } from '../src/output.js';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';

const noise = Array.from({ length: 400 }, (_, i) =>
  `INFO cache module ${i} ${'unchanged '.repeat(30)}`,
).join('\n');
const score = (probability: number) => vi.fn(async (_state: JevState, questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: probability }])),
}));

describe('information retention rules', () => {
  it.each([
    ['reference', '# Dataset usage\nSelect the metadata configuration.'],
    ['reference', 'Warning: unauthenticated download\n---\nconfigs:\n- config_name: metadata'],
    ['reference', 'Usage\n=====\nRead the input before changing it.'],
    ['reference', 'Help on class LinearGaussianBayesianNetwork:'],
    ['reference', '  401c23:\tucomiss xmm6,xmm2'],
    ['reference', '  401c23:\t0f 2e f2\tucomiss xmm6,xmm2'],
    ['reference', '817\t  401c23:\tucomiss xmm6,xmm2'],
    ['reference', 'src/index.ts:42:export const configuration = { mode: "strict" };'],
    ['reference', 'def simulate(samples):\n    return samples'],
    ['diagnostic', 'WARNING: deprecated option'],
    ['diagnostic', 'ValueError: bad input'],
    ['result', 'Tests: 17 passed, 0 failed'],
    ['result', 'Artifact: dist/app.js'],
    ['progress', 'INFO cache hit\nDownloading package 1/200'],
    ['unknown', 'serial=SN-unique-release'],
    ['unknown', 'node_modules/serialize-error/error.js'],
  ])('classifies %s content: %s', (category, content) => {
    expect(classifyInformation(content)).toBe(category);
  });

  it.each([
    ['python3 -c "print(readme)"', 'Warning: unauthenticated download\n---\nconfigs:\n- config_name: metadata\n# Dataset usage'],
    ["sed -n '577,951p' mystery.asm", '  401c23:\tucomiss xmm6,xmm2\n  401c26:\tjbe 401c54'],
    ['custom-reader', 'export const mode = "strict";'],
    ['npm run build', 'Help on class LinearGaussianBayesianNetwork:'],
  ])('preserves reference content above the token gate from %s', async (command, reference) => {
    const output = `${noise}\n${reference}\n${noise}`;
    const ask = score(0);
    const onDecision = vi.fn();
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const result = await trimOutput({ command, output, goal: 'inspect' }, { ask }, { maxChars: 1_000, onDecision });
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
    expect(onDecision).toHaveBeenCalledWith('document');
    expect(ask).not.toHaveBeenCalled();
  });

  it('prunes confirmed noise while retaining diagnostics, results and their context', async () => {
    const lines = noise.split('\n');
    const retained = [
      'WARNING: deprecated runtime option',
      'Tests: 17 passed, 0 failed',
      'Artifact: dist/app.js',
    ];
    retained.forEach((line, i) => { lines[100 + i * 60] = line; });
    const output = lines.join('\n');
    const ask = score(0);
    const result = await trimOutput(
      { command: 'npm test', output, goal: 'Check test status and artifact.' },
      { ask },
      { maxChars: 20_000 },
    );
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    expect(ask).toHaveBeenCalled();
    expect(result.trimmed).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(20_000);
    for (const line of retained) expect(result.output).toContain(line);
    expect(result.output).toContain(lines[99]);
    expect(result.output).toContain(lines[101]);
  });

  it.each([0.11, 0.49, 0.99])('keeps uncertain or needed content at score %s despite budget pressure', async probability => {
    const output = `${noise}\nrelease identifier = stable-deployment`;
    const onDecision = vi.fn();
    const result = await trimOutput(
      { command: 'inventory', output, goal: 'Keep the release identifier.' },
      { ask: score(probability) },
      { maxChars: 1_000, onDecision },
    );
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
  });

  it('preserves task-dependent facts when refinement fails', async () => {
    const lines = noise.split('\n');
    lines[207] = 'release identifier = stable-deployment';
    const output = lines.join('\n');
    const ask = vi.fn(async (state: JevState, questions: JevQuestions) => {
      if (Object.keys(questions).some(id => id.startsWith('g'))) throw new Error('scorer unavailable');
      return score(0.99)(state, questions);
    });
    const result = await trimOutput(
      { command: 'inventory', output, goal: 'Keep the release identifier.' },
      { ask },
      { maxChars: 1_000 },
    );
    expect(ask.mock.calls.some(([, questions]) => Object.keys(questions).some(id => id.startsWith('g')))).toBe(true);
    expect(result.output).toBe(output);
  });

  it('only removes a chunk after every history segment considers it disposable', async () => {
    const output = noise.replace('module 205 ', 'module 205 release_identifier=stable ');
    const ask = vi.fn(async (state: JevState, questions: JevQuestions) => {
      const { history, chunks } = state as {
        history: { text?: string }[];
        chunks: { id: string; text: string }[];
      };
      const required = JSON.stringify(history).includes('Retain release_identifier');
      return {
        answers: Object.fromEntries(Object.keys(questions).map(id => [
          id, { noul: required && chunks.find(chunk => chunk.id === id)!.text.includes('release_identifier') ? 0.99 : 0 },
        ])),
      };
    });
    const result = await trimOutput({
      command: 'inventory', output, goal: '',
      messages: [
        { role: 'user', text: 'Retain release_identifier', toolUses: [] },
        ...Array.from({ length: 10 }, () => ({ role: 'assistant' as const, text: 'earlier context '.repeat(150), toolUses: [] })),
      ],
    }, { ask }, { maxStateTokens: 5_000, maxScoringRequests: 200 });
    expect(ask.mock.calls.length).toBeGreaterThan(1);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain('release_identifier=stable');
  });
});
