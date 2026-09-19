import { describe, expect, it, vi } from 'vitest';
import { trimOutput } from '../src/output.js';
import { estimateTokens, type JevAsker } from '../src/jev.js';

function askerFor(score: (id: string) => number, calls: { count: number }): JevAsker {
  return {
    async ask(_state, questions) {
      calls.count += 1;
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [
            id,
            { type: 'noul' as const, noul: score(id) },
          ]),
        ),
      };
    },
  };
}

function outputLines(): string[] {
  return Array.from({ length: 200 }, (_, index) => `line-${index + 1} ${'cache '.repeat(55)}`);
}

function estimateOutputTokens(text: string): number {
  return estimateTokens(text) + (text.match(/\d/g)?.length ?? 0) / 2;
}

describe('character-based chunks', () => {
  const output = Array.from({ length: 30 }, (_, index) => `INFO ${index} ${'log '.repeat(360)}`).join('\n');

  it('can prune a large log that has only two line-based chunks', async () => {
    const calls = { count: 0 };
    const input = { command: 'make', goal: 'check build status', output };
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    expect((await trimOutput(input, askerFor(() => 0, calls))).trimmed).toBe(false);
    expect(calls.count).toBe(0);
    const result = await trimOutput(input, askerFor(() => 0, calls), { chunkChars: 4_000 });
    expect(result.trimmed).toBe(true);
    expect(result.chunks).toBe(15);
    expect(result.output).toContain(output.split('\n')[0]);
    expect(result.output).toContain(output.split('\n').at(-1));
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it('preserves documents and errors with character-based chunks', async () => {
    const calls = { count: 0 };
    const asker = askerFor(() => 0, calls);
    const document = await trimOutput({ command: 'cat build.log', goal: 'read', output }, asker, { chunkChars: 4_000 });
    expect(document.output).toBe(output);
    expect(calls.count).toBe(0);
    const lines = output.split('\n');
    lines[14] = 'ERROR missing required object engine.o';
    const result = await trimOutput({ command: 'make', goal: 'fix build', output: lines.join('\n') }, asker, { chunkChars: 4_000 });
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain(lines[14]);
  });

  it('caps decisions and preserves every character when all chunks are kept', async () => {
    const large = Array.from({ length: 1_000 }, (_, index) => `${index}: ${'x'.repeat(1700)}`).join('\n');
    const result = await trimOutput(
      { command: 'make', goal: 'inspect', output: large },
      askerFor(() => 1, { count: 0 }),
      { chunkChars: 10, maxStateTokens: 30_000 },
    );
    expect(result.chunks).toBeLessThanOrEqual(200);
    expect(result.output).toBe(large);
  });

  it('does not bypass the token floor', async () => {
    const calls = { count: 0 };
    const short = output.slice(0, 30_000);
    const result = await trimOutput(
      { command: 'make', goal: 'check', output: short },
      askerFor(() => 0, calls),
      { chunkChars: 1, minTokens: 0 },
    );
    expect(result.output).toBe(short);
    expect(calls.count).toBe(0);
  });
});

describe('trimOutput', () => {
  it('passes short output through without asking Jev', async () => {
    const calls = { count: 0 };
    const output = 'short output';
    const result = await trimOutput(
      { command: 'printf short', goal: 'test', output },
      askerFor(() => 0, calls),
    );
    expect(calls.count).toBe(0);
    expect(result).toEqual({
      output,
      trimmed: false,
      chunks: 0,
      kept: 0,
      dropped: 0,
      charsBefore: output.length,
      charsAfter: output.length,
      scores: [],
    });
  });

  it('keeps selected chunks and collapses dropped runs with markers', async () => {
    const calls = { count: 0 };
    const lines = outputLines();
    const output = lines.join('\n');
    const result = await trimOutput(
      {
        command: 'run command',
        goal: 'fix the test',
        output,
        fullOutputPath: '.claude/full.txt',
      },
      askerFor((id) => (id === 'c1' || id === 'c3' ? 0.9 : 0.1), calls),
      { chunkLines: 20, keepThreshold: 0.5 },
    );

    const chunk = (number: number): string =>
      lines.slice((number - 1) * 20, number * 20).join('\n');
    expect(calls.count).toBe(1);
    expect(result.trimmed).toBe(true);
    expect(result.chunks).toBe(10);
    expect(result.kept).toBe(3);
    expect(result.dropped).toBe(7);
    expect(result.scores).toHaveLength(10);
    expect(result.scores[9]).toBe(0.1);
    expect(result.output).toContain(chunk(1));
    expect(result.output).toContain(chunk(3));
    expect(result.output).toContain(chunk(10));
    expect(result.output).toContain(
      `[fast-jev-output trimmed 20 lines (${chunk(2).length} chars); full output: .claude/full.txt (Read or grep it if needed)]`,
    );
    expect(result.output).toContain(
      `[fast-jev-output trimmed 120 lines (${[4, 5, 6, 7, 8, 9]
        .map((number) => chunk(number).length)
        .reduce((sum, chars) => sum + chars, 0) + 5} chars); full output: .claude/full.txt (Read or grep it if needed)]`,
    );
    expect(result.output.indexOf(chunk(1))).toBeLessThan(result.output.indexOf(chunk(3)));
    expect(result.output.indexOf(chunk(3))).toBeLessThan(result.output.indexOf(chunk(10)));
    expect(result.charsAfter).toBeLessThan(result.charsBefore);
  });

  it('returns the original output when every chunk is kept', async () => {
    const output = outputLines().join('\n');
    const result = await trimOutput(
      { command: 'run command', goal: 'test', output },
      askerFor(() => 0.9, { count: 0 }),
      { chunkLines: 20 },
    );
    expect(result.trimmed).toBe(false);
    expect(result.output).toBe(output);
    expect(result.dropped).toBe(0);
    expect(result.charsAfter).toBe(result.charsBefore);
  });

  it('rejects when Jev fails', async () => {
    const asker: JevAsker = {
      async ask() {
        throw new Error('network unavailable');
      },
    };
    await expect(
      trimOutput(
        { command: 'run command', goal: 'test', output: outputLines().join('\n') },
        asker,
        { chunkLines: 20 },
      ),
    ).rejects.toThrow('network unavailable');
  });

  it('retries with a smaller state after max_tokens_exceeded', async () => {
    let calls = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        calls += 1;
        if (calls === 1) {
          throw new Error(
            'Jev request failed (400): {"detail":{"error_type":"max_tokens_exceeded"}}',
          );
        }
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'noul' as const, noul: id === 'c1' || id === 'c10' ? 0.9 : 0.1 },
            ]),
          ),
        };
      },
    };
    const result = await trimOutput(
      { command: 'run command', goal: 'test', output: outputLines().join('\n') },
      asker,
      { chunkLines: 20 },
    );
    expect(result.trimmed).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('bounds retries when max_tokens_exceeded persists', async () => {
    const attempts = new Map<string, number>();
    const asker: JevAsker = {
      async ask(_state, questions) {
        Object.keys(questions).forEach(id => attempts.set(id, (attempts.get(id) ?? 0) + 1));
        throw new Error(
          'Jev request failed (400): {"detail":{"error_type":"max_tokens_exceeded"}}',
        );
      },
    };
    await expect(
      trimOutput(
        { command: 'run command', goal: 'test', output: outputLines().join('\n') },
        asker,
        { chunkLines: 20 },
      ),
    ).rejects.toThrow('max_tokens_exceeded');
    expect([...attempts.values()]).toEqual(Array(10).fill(3));
  });

  it('fits digit-heavy output to the state budget', async () => {
    const output = Array.from({ length: 20_000 }, (_, index) => String(index + 1)).join('\n');
    const defaultStates: number[] = [];
    const asker = (states: number[]): JevAsker => ({
      async ask(state, questions) {
        states.push(estimateOutputTokens(JSON.stringify(state)));
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [
              id,
              { type: 'noul' as const, noul: 0.1 },
            ]),
          ),
        };
      },
    });

    const result = await trimOutput(
      { command: 'seq 1 20000', goal: '', output },
      asker(defaultStates),
      {},
    );
    expect(result.trimmed).toBe(true);
    expect(result.output).toContain('1\n2');
    expect(result.output).toContain('19999\n20000');
    expect(defaultStates.length).toBeGreaterThan(0);
    expect(defaultStates.every((tokens) => tokens <= 25_000)).toBe(true);

    const smallStates: number[] = [];
    await trimOutput(
      { command: 'seq 1 20000', goal: '', output },
      asker(smallStates),
      { maxStateTokens: 5_000 },
    );
    expect(smallStates.length).toBeGreaterThan(0);
    expect(Math.max(...smallStates)).toBeLessThan(Math.max(...defaultStates));
  });
});

describe('trimOutput safety', () => {
  const asker = (score: number) => ({
    ask: async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: score }]),
      ),
    }),
  });
  const lines = (n: number, make: (i: number) => string) =>
    Array.from({ length: n }, (_, i) => make(i)).join('\n');

  it('leaves a JSON document alone', async () => {
    const json = JSON.stringify({ items: Array.from({ length: 400 }, (_, i) => ({ i })) }, null, 2);
    const r = await trimOutput({ command: 'cat items.json', goal: 'g', output: json }, asker(0));
    expect(r.trimmed).toBe(false);
    expect(r.output).toBe(json);
  });

  it('leaves binary output alone', async () => {
    const bin = Array.from({ length: 9000 }, (_, i) => String.fromCharCode(i % 256)).join('');
    const r = await trimOutput({ command: 'run', goal: 'g', output: bin }, asker(0));
    expect(r.trimmed).toBe(false);
  });

  it('keeps a chunk that looks like an error even when Jev says drop', async () => {
    const out = lines(400, (i) => (i === 200 ? 'ERROR: boom' : `[${i}] compiled module ${i} fine ${'cache '.repeat(30)}`));
    const r = await trimOutput({ command: 'npm run build', goal: 'g', output: out }, asker(0));
    expect(r.trimmed).toBe(true);
    expect(r.output).toContain('ERROR: boom');
  });

  it('keeps chunks that were never scored instead of dropping them', async () => {
    const out = lines(6000, (i) => `[${i}] ${'detail '.repeat(20)}`);
    const r = await trimOutput(
      { command: 'npm run build', goal: 'g', output: out },
      asker(0),
      { maxStateTokens: 1_000 },
    );
    expect(r.output).toContain('[3000]');
  });

  it('splits one enormous line so it can still be trimmed', async () => {
    const r = await trimOutput(
      { command: 'run', goal: 'g', output: 'x'.repeat(60_006) },
      asker(0),
      { chunkLines: 5 },
    );
    expect(r.chunks).toBeGreaterThan(2);
  });
});

describe('budget for engine-saved output', () => {
  const asker = (score: number) => ({
    ask: async (_state: unknown, questions: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: score }])),
    }),
  });
  const withNeedle = (n: number, at: number) =>
    Array.from({ length: n }, (_, i) => (i === at ? 'ERROR worker-4 KeyError discount order=ORD-77341' : `INFO request ${i} ok`)).join('\n');

  it('preserves the output when Jev keeps content beyond the budget', async () => {
    const output = withNeedle(3000, 1700);
    const onDecision = vi.fn();
    const r = await trimOutput(
      { command: 'tail -n +1 big.log', goal: 'g', output },
      asker(0.9),
      { maxChars: 4_000, onDecision },
    );
    expect(r.output).toBe(output);
    expect(r.trimmed).toBe(false);
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
  });

  it('never drops an error line to meet the budget', async () => {
    for (const lines of [2000, 3000, 12000]) {
      const output = withNeedle(lines, Math.floor(lines * 0.57));
      expect(estimateTokens(output)).toBeGreaterThan(10_000);
      const r = await trimOutput(
        { command: 'tail -n +1 big.log', goal: 'g', output },
        asker(0.01),
        { maxChars: 2_000 },
      );
      expect(r.output).toContain('ORD-77341');
    }
  });

  it('shrinks an oversized chunk instead of dropping it, and says how many lines went', async () => {
    const r = await trimOutput(
      { command: 'tail -n +1 big.log', goal: 'g', output: withNeedle(40_000, 22_800) },
      asker(0.01),
      { maxChars: 8_000 },
    );
    expect(r.output).toContain('ORD-77341');
    expect(r.output).toMatch(/trimmed \d+ more lines from this section/);
    expect(r.charsAfter).toBeLessThanOrEqual(8_000);
  });

  it('leaves output alone when no budget is set', async () => {
    const output = withNeedle(3000, 1700);
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const r = await trimOutput({ command: 'x', goal: 'g', output }, asker(0.9));
    expect(r.trimmed).toBe(false);
  });
});

describe('line-level second pass', () => {
  const withNeedle = (n: number, at: number) =>
    Array.from({ length: n }, (_, i) => (i === at ? 'ERROR worker-4 KeyError discount order=ORD-77341' : `INFO request ${i} ok`)).join('\n');
  const counting = (score: number, calls: { n: number }) => ({
    ask: async (_state: unknown, questions: Record<string, unknown>) => {
      calls.n += 1;
      return { answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: score }])) };
    },
  });

  it('asks Jev again inside an oversized chunk', async () => {
    const calls = { n: 0 };
    const r = await trimOutput(
      { command: 'tail -n +1 big.log', goal: 'g', output: withNeedle(40_000, 22_800) },
      counting(0.01, calls),
      { maxChars: 8_000 },
    );
    expect(calls.n).toBeGreaterThan(1);
    expect(r.charsAfter).toBeLessThanOrEqual(8_000);
    expect(r.output).toContain('ORD-77341');
  });

  it('keeps an error line even when Jev drops its group', async () => {
    const r = await trimOutput(
      { command: 'tail -n +1 big.log', goal: 'g', output: withNeedle(40_000, 22_800) },
      { ask: async (_s: unknown, q: Record<string, unknown>) => ({ answers: Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul' as const, noul: 0 }])) }) },
      { maxChars: 4_000 },
    );
    expect(r.output).toContain('ORD-77341');
  });

  it('preserves output when failed refinement prevents a safe fit', async () => {
    let refinements = 0;
    const flaky = {
      ask: async (_s: unknown, q: Record<string, unknown>) => {
        if (Object.keys(q).some((id) => id.startsWith('g'))) {
          refinements += 1;
          throw new Error('jev down');
        }
        return { answers: Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul' as const, noul: 0.01 }])) };
      },
    };
    const output = withNeedle(40_000, 22_800);
    const onDecision = vi.fn();
    const r = await trimOutput(
      { command: 'tail -n +1 big.log', goal: 'g', output },
      flaky,
      { maxChars: 8_000, onDecision },
    );
    expect(refinements).toBeGreaterThan(0);
    expect(r.output).toContain('ORD-77341');
    expect(r.output).toBe(output);
    expect(r.trimmed).toBe(false);
    expect(onDecision).toHaveBeenCalledWith('budget_unfit');
  });
});

describe('budget ordering', () => {
  it('shrinks the biggest chunks before dropping anything, so a wanted chunk survives a tight budget', async () => {
    const lines = Array.from({ length: 12_000 }, (_, i) =>
      i === 6_840 ? 'item-4821 qty=13 bin=Z9 serial=SN-88431-XQ status=quarantined' : `INFO request ${i} served in ${i % 400}ms`,
    ).join('\n');
    // Only the needle's chunk scores high; the first and last chunks alone are
    // larger than the budget, which used to force every other chunk out.
    const asker = {
      ask: async (_state: unknown, questions: Record<string, unknown>) => ({
        answers: Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: id === 'c115' ? 0.97 : 0.02 }]),
        ),
      }),
    };
    const r = await trimOutput(
      { command: 'tail -n +1 app.log', goal: 'Find the serial number of the quarantined item.', output: lines },
      asker,
      { maxChars: 8_000 },
    );
    expect(r.output).toContain('SN-88431-XQ');
    expect(r.charsAfter).toBeLessThanOrEqual(8_000);
  });
});

describe('error floor is narrow', () => {
  const asker = {
    ask: async (_s: unknown, q: Record<string, unknown>) => ({
      answers: Object.fromEntries(Object.keys(q).map((id) => [id, { type: 'noul' as const, noul: 0.01 }])),
    }),
  };

  it('does not treat a file listing full of error-named files as errors', async () => {
    const listing = Array.from({ length: 400 }, (_, i) => `-rw-r--r--  1 me staff  ${i} Sep 18 node_modules/serialize-error/error-${i}.js`).join('\n');
    const r = await trimOutput({ command: 'ls -laR node_modules', goal: 'check the tree', output: listing }, asker, { maxChars: 4_000 });
    expect(r.charsAfter).toBeLessThanOrEqual(4_000);
  });

  it.each([1_000, 2_000, 4_000])('protects a reported failure and its context with budget %i', async maxChars => {
    const noise = Array.from({ length: 400 }, (_, i) => `[${i}] compiled module ${i} ${'cache '.repeat(30)}`);
    for (const line of [
      'ERROR worker-3 failed to link checkout_v2',
      'TypeError: Cannot read properties of undefined',
      'error: could not find a version satisfying pandas==99.9',
      '7 high severity vulnerabilities found',
      'payments checkout-77 0/1 CrashLoopBackOff 14 22m',
    ]) {
      const rows = [...noise];
      rows[200] = line;
      expect(estimateTokens(rows.join('\n'))).toBeGreaterThan(10_000);
      const onDecision = vi.fn();
      const r = await trimOutput({ command: 'build', goal: 'fix the build', output: rows.join('\n') }, asker, { maxChars, onDecision });
      expect(r.output).toContain(line);
      expect(r.output).toContain(rows[199]);
      expect(r.output).toContain(rows[201]);
      expect(r.trimmed).toBe(maxChars >= 2_000);
      if (maxChars >= 2_000) {
        expect(r.charsAfter).toBeLessThanOrEqual(maxChars);
        expect(onDecision).toHaveBeenCalledWith('pruned');
      } else {
        expect(r.output).toBe(rows.join('\n'));
        expect(onDecision).toHaveBeenCalledWith('budget_unfit');
      }
    }
  });
});

describe('reference retention takes precedence over the budget', () => {
  it('preserves all source excerpts without scoring', async () => {
    const output = Array.from({ length: 2_000 }, (_, i) => `src/module_${i}/index.ts:${i}:export const thing${i} = ${i};`).join('\n');
    const calls = { count: 0 };
    const onDecision = vi.fn();
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const r = await trimOutput({ command: 'grep -rn export src/', goal: 'list the exports', output }, askerFor(() => 0, calls), { maxChars: 6_000, onDecision });
    expect(r.output).toBe(output);
    expect(r.trimmed).toBe(false);
    expect(calls.count).toBe(0);
    expect(onDecision).toHaveBeenCalledWith('document');
  });

  it('preserves both source excerpts and a failure within them', async () => {
    const rows = Array.from({ length: 2_000 }, (_, i) => `src/module_${i}/index.ts:${i}:export const thing${i} = ${i};`);
    rows[1_500] = 'src/checkout/parser.ts:88: error: Cannot read properties of undefined (reading discount)';
    const output = rows.join('\n');
    const calls = { count: 0 };
    const onDecision = vi.fn();
    expect(estimateTokens(output)).toBeGreaterThan(10_000);
    const r = await trimOutput({ command: 'grep -rn export src/', goal: 'list the exports', output }, askerFor(() => 0, calls), { maxChars: 6_000, onDecision });
    expect(r.output).toContain('reading discount');
    expect(r.output).toBe(output);
    expect(r.trimmed).toBe(false);
    expect(calls.count).toBe(0);
    expect(onDecision).toHaveBeenCalledWith('document');
  });
});
