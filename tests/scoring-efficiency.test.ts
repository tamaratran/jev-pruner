import { describe, expect, it, vi } from 'vitest';
import type { JevAsker, JevQuestions } from '../src/jev.js';
import { estimateTokens } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

const progress = () => Array.from({ length: 600 }, (_, index) =>
  `progress: item ${index} ${'cached '.repeat(16)}`);
const answer = (questions: JevQuestions, score: number) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: score }])),
});
const input = (lines: string[]) => ({
  command: 'build',
  goal: 'Keep diagnostics and final results.',
  output: lines.join('\n'),
  fullOutputPath: '/logs/full.txt',
});

describe('scoring feasibility', () => {
  it('does not score when required diagnostic text alone exceeds the preview', async () => {
    const lines = progress().map((line, index) => index % 8 === 0 ? `ERROR: ${line}` : line);
    const ask = vi.fn(async (_state, questions) => answer(questions, 0));
    const onDecision = vi.fn();
    const value = input(lines);
    expect(estimateTokens(value.output)).toBeGreaterThan(10_000);
    const result = await trimOutput(value, { ask }, { maxChars: 2000, compactMarkers: true, onDecision });
    expect(result.output).toBe(value.output);
    expect(ask).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
  });

  it('includes adjacent context across chunk boundaries in the required floor', async () => {
    const lines = progress();
    lines[18] = 'left context '.repeat(75);
    lines[19] = 'ERROR: failed request';
    lines[20] = 'right context '.repeat(75);
    const ask = vi.fn(async (_state, questions) => answer(questions, 0));
    const value = input(lines);
    const result = await trimOutput(value, { ask }, { maxChars: 2000, compactMarkers: true });
    expect(result.output).toBe(value.output);
    expect(ask).not.toHaveBeenCalled();
  });

  it('includes fixed compact metadata in the pre-scoring floor', async () => {
    const value = { ...input(progress()), fullOutputPath: `/logs/${'nested/'.repeat(200)}full.txt` };
    const ask = vi.fn(async (_state, questions) => answer(questions, 0));
    const result = await trimOutput(value, { ask }, { maxChars: 1600, compactMarkers: true });
    expect(result.output).toBe(value.output);
    expect(ask).not.toHaveBeenCalled();
  });

  it('stops after a refined chunk must retain more text than can fit', async () => {
    let refinements = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        if (Object.keys(questions).some(id => id.startsWith('g'))) refinements += 1;
        return answer(questions, 0.11);
      },
    };
    const value = input(progress());
    const result = await trimOutput(value, asker, { maxChars: 1000, compactMarkers: true });
    expect(result.output).toBe(value.output);
    expect(refinements).toBe(1);
  });

  it('still prunes within a small request allowance while retaining facts and context', async () => {
    const lines = progress();
    lines[300] = 'ERROR: deployment blocked';
    lines[599] = 'Exit status: 1';
    const ask = vi.fn(async (_state, questions) => answer(questions, 0.01));
    const result = await trimOutput(input(lines), { ask }, {
      maxChars: 1500, compactMarkers: true, maxScoringRequests: 5,
    });
    expect(result.trimmed).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(1500);
    expect(ask.mock.calls.length).toBeLessThanOrEqual(6);
    for (const index of [0, 299, 300, 301, 598, 599]) {
      expect(result.output).toContain(lines[index]);
    }
  });
});
