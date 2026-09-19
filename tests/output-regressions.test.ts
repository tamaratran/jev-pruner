import { describe, expect, it, vi } from 'vitest';
import { trimOutput } from '../src/output.js';
import { estimateStateTokens, estimateTokens, type JevAsker, type JevQuestions } from '../src/jev.js';

function answersFor(questions: JevQuestions, score: (id: string) => number) {
  return {
    answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: score(id) }])),
  };
}

const keepEverything: JevAsker = {
  async ask(_state, questions) {
    return answersFor(questions, () => 0.99);
  },
};

describe('complete scoring and request limits', () => {
  it('scores a quiet needle beyond the prefix of a middle chunk', async () => {
    const needle = 'serial=SN-88431-XQ';
    const lines = Array.from({ length: 4_000 }, (_, index) => `item ${index} ${'z'.repeat(80)}`);
    lines[2_010] = needle;
    let seen = false;
    const asker: JevAsker = {
      async ask(state, questions) {
        const { chunks } = state as { chunks: Array<{ id: string; text: string }> };
        expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(25_000);
        return answersFor(questions, id => {
          const relevant = chunks.find(chunk => chunk.id === id)!.text.includes(needle);
          seen ||= relevant;
          return relevant ? 0.99 : 0.01;
        });
      },
    };
    const result = await trimOutput(
      { command: 'inventory', goal: 'Find the target serial', output: lines.join('\n') },
      asker,
    );
    expect(seen).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(needle);
  });

  it.each([0, 1])('allows at most one initial request plus %i additional requests', async extra => {
    let calls = 0;
    const output = Array.from({ length: 4_000 }, (_, index) =>
      `INFO item ${index} ${'x'.repeat(30)}`,
    ).join('\n');
    await trimOutput(
      { command: 'build', goal: 'g', output },
      {
        async ask(state, questions) {
          calls += 1;
          return keepEverything.ask(state, questions);
        },
      },
      { maxChars: 8_000, maxScoringRequests: extra },
    );
    expect(calls).toBeLessThanOrEqual(1 + extra);
    expect(calls).toBeGreaterThan(0);
  });

  it('shares the request limit with token-limit retries', async () => {
    let calls = 0;
    await expect(trimOutput(
      { command: 'build', goal: 'g', output: 'progress log\n'.repeat(4_000) },
      {
        async ask() {
          calls += 1;
          throw new Error('max_tokens_exceeded');
        },
      },
      { maxScoringRequests: 1 },
    )).rejects.toThrow('max_tokens_exceeded');
    expect(calls).toBe(2);
  });

  it('preserves unscored tails when the request budget runs out', async () => {
    const lines = Array.from({ length: 4_000 }, (_, index) => `item ${index} ${'z'.repeat(80)}`);
    lines[3_810] = 'serial=unseen-release';
    const result = await trimOutput(
      { command: 'inventory', goal: 'Find the release serial', output: lines.join('\n') },
      { async ask(_state, questions) { return answersFor(questions, () => 0); } },
      { maxScoringRequests: 0 },
    );
    expect(result.output).toContain('serial=unseen-release');
  });

  it('preserves chunks not scored against every history segment', async () => {
    const output = Array.from({ length: 200 }, (_, index) =>
      `module ${index} ${'cache '.repeat(55)}`,
    ).join('\n');
    let calls = 0;
    const result = await trimOutput(
      {
        command: 'build', goal: '', output,
        messages: Array.from({ length: 30 }, () => ({
          role: 'user' as const, text: 'details '.repeat(200), toolUses: [],
        })),
      },
      { async ask(_state, questions) {
        calls += 1;
        return answersFor(questions, () => 0);
      } },
      { maxStateTokens: 6_000, maxScoringRequests: 0 },
    );
    expect(calls).toBe(1);
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});

describe('rendered output budgets', () => {
  it('keeps the error and all needed content when an oversized chunk cannot fit', async () => {
    const lines = Array.from({ length: 60 }, (_, index) => `row ${index} ${'x'.repeat(1_400)}`);
    lines[10] = 'ERROR: unique failure NEEDLE';
    const output = lines.join('\n');
    const onDecision = vi.fn();
    const result = await trimOutput(
      { command: 'build', goal: 'Find the error', output },
      keepEverything,
      { maxChars: 8_000, onDecision },
    );
    expect(result.output).toContain(lines[10]);
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
  });

  it.each([
    [8_000, false],
    [40_000, true],
  ] as const)('preserves needed chunks and accounts for omission markers with budget %i', async (maxChars, trimmed) => {
    const output = Array.from({ length: 2_000 }, (_, index) =>
      `INFO item ${index} ${'x'.repeat(15)}`,
    ).join('\n');
    const onDecision = vi.fn();
    const result = await trimOutput(
      { command: 'build', goal: 'g', output, fullOutputPath: '.claude/fast-jev-output/bash-test.txt' },
      { async ask(_state, questions) {
        return answersFor(questions, id => id.startsWith('g') || Number(id.slice(1)) % 2 ? 0.99 : 0.01);
      } },
      { maxChars, onDecision },
    );
    expect(result.trimmed).toBe(trimmed);
    for (const [index, line] of output.split('\n').entries()) {
      if (Math.floor(index / 20) % 2 === 0) expect(result.output).toContain(line);
    }
    if (trimmed) {
      expect(result.output).toContain('full output: .claude/fast-jev-output/bash-test.txt');
      expect(result.output.length).toBeLessThanOrEqual(maxChars);
      expect(result.dropped).toBeGreaterThan(0);
      expect(onDecision).toHaveBeenCalledWith('pruned');
    } else {
      expect(result.output).toBe(output);
      expect(onDecision).toHaveBeenCalledWith('budget_unfit');
    }
    expect(result.charsAfter).toBe(result.output.length);
  });

  it('returns within-chunk shrinking even when no whole chunk is dropped', async () => {
    const output = Array.from({ length: 300 }, (_, index) =>
      index % 100 === 50 ? `ERROR: shard ${index} is unavailable`
        : `INFO ${String(index).padStart(3, '0')} ${'x'.repeat(200)}`,
    ).join('\n');
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    let refinements = 0;
    const result = await trimOutput(
      { command: 'build', goal: 'g', output },
      { async ask(_state, questions) {
        for (const [id, question] of Object.entries(questions)) {
          expect(question.instructions).toContain(`Chunk ${id} `);
        }
        if (Object.keys(questions)[0]!.startsWith('g')) refinements += 1;
        return answersFor(questions, id => id.startsWith('g') ? 0.01 : 0.99);
      } },
      { chunkLines: 100, maxChars: 35_000 },
    );
    expect(refinements).toBeGreaterThan(0);
    expect(result.dropped).toBe(0);
    expect(result.trimmed).toBe(true);
    expect(result.output).not.toBe(output);
    expect(result.output.length).toBeLessThanOrEqual(35_000);
    for (const index of [50, 150, 250]) {
      expect(result.output).toContain(`ERROR: shard ${index} is unavailable`);
    }
  });

  it('preserves every failure when the failures alone exceed the budget', async () => {
    const output = Array.from({ length: 600 }, (_, index) => `ERROR ${index} ${'detail '.repeat(20)}`).join('\n');
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const result = await trimOutput(
      { command: 'build', goal: 'Find all failures', output },
      keepEverything,
      { maxChars: 1_000 },
    );
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });

  it('uses every history segment when refining a kept chunk', async () => {
    const needle = 'serial=SN-88431-XQ';
    const lines = Array.from({ length: 300 }, (_, index) => `item ${index} ${'x'.repeat(200)}`);
    lines[130] = needle;
    let refinedWithRequirement = false;
    const result = await trimOutput(
      {
        command: 'inventory', goal: '', output: lines.join('\n'),
        messages: [
          ...Array.from({ length: 30 }, () => ({
            role: 'assistant' as const, text: 'details '.repeat(200), toolUses: [],
          })),
          { role: 'user', text: 'retain serial', toolUses: [] },
        ],
      },
      { async ask(state, questions) {
        const { chunks, history } = state as { chunks: { id: string; text: string }[]; history: unknown };
        expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(8_000);
        const requirement = JSON.stringify(history).includes('retain serial');
        refinedWithRequirement ||= requirement && Object.keys(questions)[0]!.startsWith('g');
        return answersFor(questions, id => (
          id.startsWith('c') || requirement && chunks.find(chunk => chunk.id === id)!.text.includes(needle)
        ) ? 0.99 : 0.01);
      } },
      { chunkLines: 100, maxStateTokens: 8_000, maxChars: 20_000 },
    );
    expect(refinedWithRequirement).toBe(true);
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(needle);
    expect(result.output.length).toBeLessThanOrEqual(20_000);
  });

  it('does not discard unscored content to meet the output budget', async () => {
    const output = Array.from({ length: 4_000 }, (_, index) => `item ${index} ${'z'.repeat(80)}`).join('\n');
    const result = await trimOutput(
      { command: 'inventory', goal: 'g', output },
      keepEverything,
      { maxScoringRequests: 0, maxChars: 8_000 },
    );
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});
