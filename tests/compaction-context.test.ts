import { describe, expect, it } from 'vitest';
import type { JevAsker } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

describe('diagnostic context across output chunks', () => {
  it('provides the final failure while scoring early progress and refining separate chunks', async () => {
    const lines = Array.from({ length: 1800 }, (_, index) =>
      `progress: cache entry ${index} already current; ${'unchanged '.repeat(5)}`);
    lines[850] = 'ERROR: required deployment directory is read-only.';
    lines[1799] = 'Build failed. Exit status: 1';
    let refinements = 0;
    const asker: JevAsker = {
      async ask(state, questions) {
        const context = state as {
          diagnosticsAndResults: string[];
          chunks: { id: string; text: string }[];
        };
        expect(context.diagnosticsAndResults).toEqual([lines[850], lines[1799]]);
        if (Object.keys(questions).some(id => id.startsWith('g'))) refinements += 1;
        return {
          answers: Object.fromEntries(context.chunks
            .filter(chunk => chunk.id in questions)
            .map(chunk => [chunk.id, { noul: /ERROR|Exit status/.test(chunk.text) ? 0.99 : 0.01 }])),
        };
      },
    };
    const result = await trimOutput(
      { command: 'build', goal: 'Report the deployment blocker and exit status.', output: lines.join('\n') },
      asker,
      { maxChars: 1900 },
    );
    expect(refinements).toBeGreaterThan(0);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(lines[850]);
    expect(result.output).toContain(lines[1799]);
    expect(result.charsAfter).toBeLessThanOrEqual(1900);
  });

  it('fails open when the diagnostic context cannot fit the scoring budget', async () => {
    const output = Array.from({ length: 1200 }, (_, i) =>
      `ERROR ${i}: ${'diagnostic '.repeat(20)}`).join('\n');
    let requests = 0;
    const result = await trimOutput(
      { command: 'build', goal: 'Inspect failures.', output },
      { async ask() { requests += 1; throw new Error('unexpected scoring request'); } },
      { maxChars: 1900, maxStateTokens: 1000 },
    );
    expect(requests).toBe(0);
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});
