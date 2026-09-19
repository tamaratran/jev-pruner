import { describe, expect, it } from 'vitest';
import type { JevAsker } from '../src/jev.js';
import { estimateTokens } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

const lines = Array.from({ length: 1800 }, (_, index) =>
  `progress: cache entry ${index} already current; ${'unchanged '.repeat(5)}`);
lines[850] = 'ERROR: deployment blocked because the release directory is not writable.';
lines[1799] = 'Build failed. Exit status: 1';
const input = {
  command: 'build',
  goal: 'Report the deployment blocker and exit status.',
  output: lines.join('\n'),
  fullOutputPath: '/logs/full-output.txt',
};

describe('compaction within native previews', () => {
  it('isolates required lines from surrounding noise before fitting a tight budget', async () => {
    const refined: string[] = [];
    const asker: JevAsker = {
      async ask(state, questions) {
        const { chunks } = state as { chunks: { id: string; text: string }[] };
        return {
          answers: Object.fromEntries(Object.keys(questions).map(id => {
            const text = chunks.find(chunk => chunk.id === id)!.text;
            if (id.startsWith('g')) refined.push(text);
            return [id, { noul: /ERROR|Exit status/.test(text) ? 0.99 : 0.01 }];
          })),
        };
      },
    };
    expect(estimateTokens(input.output)).toBeGreaterThan(10_000);
    const result = await trimOutput(input, asker, { maxChars: 1900 });
    expect(refined.length).toBeGreaterThan(0);
    expect(refined.every(text => !text.includes('\n'))).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.charsAfter).toBeLessThanOrEqual(1900);
    for (const index of [0, 849, 850, 851, 1798, 1799]) {
      expect(result.output).toContain(lines[index]);
    }
    expect(result.output).toContain('full output: /logs/full-output.txt');
  });

  it.each(['uncertain', 'missing', 'failed'] as const)(
    'preserves the original when line refinement is %s',
    async mode => {
      const asker: JevAsker = {
        async ask(_state, questions) {
          const refining = Object.keys(questions).some(id => id.startsWith('g'));
          if (refining && mode === 'failed') throw new Error('unavailable');
          return {
            answers: refining && mode === 'missing' ? {} : Object.fromEntries(
              Object.keys(questions).map(id => [id, { noul: refining ? 0.11 : 0.99 }]),
            ),
          };
        },
      };
      const result = await trimOutput(input, asker, { maxChars: 1900 });
      expect(result.output).toBe(input.output);
      expect(result.trimmed).toBe(false);
    },
  );
});
