import { describe, expect, it, vi } from 'vitest';
import { trimOutput } from '../src/output.js';
import type { JevAsker } from '../src/jev.js';

const output = Array.from({ length: 30 }, () => 'log '.repeat(360)).join('\n');
const asker: JevAsker = {
  async ask(_state, questions) {
    return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 1 }])) };
  },
};

describe('library pruning decisions', () => {
  it.each([
    ['below_threshold', 'short', 'make', {}],
    ['binary', `${output}\0`, 'make', {}],
    ['document', output, 'cat source.txt', {}],
    ['few_chunks', output, 'make', {}],
    ['kept_all', output, 'make', { chunkChars: 4_000 }],
    ['budget_unfit', output, 'make', { chunkChars: 4_000, maxChars: 1 }],
  ] as const)('reports %s', async (reason, text, command, options) => {
    const onDecision = vi.fn();
    await trimOutput({ command, goal: 'check', output: text }, asker, { ...options, onDecision });
    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith(reason);
  });
});
