import { describe, expect, it } from 'vitest';
import { splitHistory } from '../src/history.js';
import type { ConversationMessage, HistoryEntry } from '../src/history.js';
import { estimateStateTokens } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

describe('scoring request ordering under a fixed allowance', () => {
  it.each([0, 200])('completes history coverage with a %i-character final message', async padding => {
    const lines = Array.from({ length: 600 }, (_, index) =>
      `progress module ${index}: ${'unchanged '.repeat(12)}`,
    );
    lines[45] = 'Selected release: artifact-cobalt.tar.gz';
    const output = lines.join('\n');
    const messages: ConversationMessage[] = [
      ...Array.from({ length: 30 }, (_, index) => ({
        role: 'user' as const, text: `Context ${index}: ${'details '.repeat(200)}`, toolUses: [],
      })),
      { role: 'user', text: `KEEP_COBALT ${'x'.repeat(padding)}`, toolUses: [] },
    ];
    const histories = splitHistory(messages, 3_000);
    const coverage = new Map<string, Set<string>>();
    let calls = 0;
    let active = 0;
    let peak = 0;
    const result = await trimOutput(
      { command: 'build', goal: '', output, messages },
      {
        async ask(state, questions) {
          calls += 1;
          active += 1;
          peak = Math.max(peak, active);
          const { history } = state as { history: HistoryEntry[] };
          const serialized = JSON.stringify(history);
          expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(6_000);
          for (const id of Object.keys(questions)) {
            const segments = coverage.get(id) ?? new Set<string>();
            segments.add(serialized);
            coverage.set(id, segments);
          }
          await Promise.resolve();
          active -= 1;
          return {
            answers: Object.fromEntries(Object.keys(questions).map(id =>
              [id, { noul: id === 'c3' && serialized.includes('KEEP_COBALT') ? 1 : 0 }],
            )),
          };
        },
      },
      { maxStateTokens: 6_000, maxScoringRequests: 19 },
    );
    expect(calls).toBe(20);
    expect(peak).toBe(calls);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(lines[45]);
    const chunks = Array.from({ length: 30 }, (_, index) => ({
      id: `c${index + 1}`, text: lines.slice(index * 20, (index + 1) * 20).join('\n'),
    }));
    let dropped = 0;
    let incomplete = 0;
    for (const chunk of chunks) {
      if (coverage.get(chunk.id)?.size !== histories.length) {
        incomplete += 1;
        expect(result.output).toContain(chunk.text);
      } else if (!result.output.includes(chunk.text)) {
        dropped += 1;
      }
    }
    expect(dropped).toBeGreaterThan(0);
    expect(incomplete).toBeGreaterThan(0);
  });
});
