import { describe, expect, it } from 'vitest';
import type { JevAsker } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

describe('refined chunk boundaries', () => {
  it('joins completely disposable refined chunks into omitted runs', async () => {
    const lines = Array.from({ length: 1800 }, (_, index) =>
      `progress: cache entry ${index} already current; ${'unchanged '.repeat(5)}`);
    lines[850] = 'ERROR: deployment blocked by a read-only directory.';
    lines[1799] = 'Build failed. Exit status: 1';
    const asker: JevAsker = {
      async ask(state, questions) {
        const { chunks } = state as { chunks: { id: string; text: string }[] };
        return {
          answers: Object.fromEntries(chunks.filter(chunk => chunk.id in questions).map(chunk => [
            chunk.id,
            { noul: /ERROR|Exit status/.test(chunk.text) ? 0.99
              : ['c2', 'c3'].includes(chunk.id) ? 0.12 : 0.01 },
          ])),
        };
      },
    };
    const result = await trimOutput(
      { command: 'build', goal: 'Report the failure.', output: lines.join('\n'), fullOutputPath: '/logs/full.txt' },
      asker,
      { maxChars: 1300 },
    );
    expect(result.trimmed).toBe(true);
    expect(result.kept).toBe(3);
    expect(result.charsAfter).toBeLessThanOrEqual(1300);
    for (const index of [0, 849, 850, 851, 1798, 1799]) {
      expect(result.output).toContain(lines[index]);
    }
    for (const index of [20, 39, 40, 59]) {
      expect(result.output).not.toContain(lines[index]);
    }
    expect(result.output).toContain('/logs/full.txt');
  });

  it('retains context across chunk edges even when Jev marks all lines disposable', async () => {
    const lines = Array.from({ length: 1800 }, (_, index) =>
      `progress: cache entry ${index} already current; ${'unchanged '.repeat(5)}`);
    lines[839] = 'ERROR: failure on a chunk boundary.';
    lines[1200] = 'Summary: 42 cases failed';
    const result = await trimOutput(
      { command: 'build', goal: 'Report failures.', output: lines.join('\n') },
      {
        async ask(_state, questions) {
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])) };
        },
      },
      { maxChars: 1900 },
    );
    expect(result.trimmed).toBe(true);
    for (const index of [0, 838, 839, 840, 1199, 1200, 1201, 1799]) {
      expect(result.output).toContain(lines[index]);
    }
  });
});
