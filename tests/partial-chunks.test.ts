import { describe, expect, it } from 'vitest';
import { trimOutput } from '../src/output.js';
import type { JevAsker } from '../src/jev.js';

describe('partially represented chunks', () => {
  it.each([3_000, 1_000])('retains unseen values at a %i-token state budget', async (maxStateTokens) => {
    const required = 'release identifier = build-7f84';
    const lines = Array.from({ length: 200 }, () => 'progress: unchanged');
    for (let index = 60; index < 80; index += 1) lines[index] = 'context '.repeat(200);
    lines[65] += required;
    const states: string[] = [];
    const asker: JevAsker = {
      async ask(state, questions) {
        states.push(JSON.stringify(state));
        return {
          answers: Object.fromEntries(Object.keys(questions).map(id => [
            id, { type: 'noul' as const, noul: 0 },
          ])),
        };
      },
    };
    const result = await trimOutput(
      {
        command: 'build',
        goal: 'Keep the release identifier.',
        output: lines.join('\n'),
      },
      asker,
      { minChars: 1, maxStateTokens },
    );
    expect(states.length).toBeGreaterThan(0);
    expect(states.every(state => !state.includes(required))).toBe(true);
    if (maxStateTokens === 3_000) expect(states.some(state => state.includes('"id":"c4"'))).toBe(true);
    expect(result.output).toContain(lines[65]);
    expect(result.scores[3]).toBe(0);
    expect(result.trimmed).toBe(maxStateTokens === 3_000);
  });
});
