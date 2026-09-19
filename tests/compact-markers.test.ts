import { describe, expect, it } from 'vitest';
import type { JevAsker } from '../src/jev.js';
import { trimOutput } from '../src/output.js';
import { classifyInformation, isProtectedLine } from '../src/retention.js';

const lines = Array.from({ length: 1800 }, (_, index) =>
  `progress: item ${index} completed; ${'cached '.repeat(6)}`);
const failures = [350, 650, 950, 1250, 1550];
for (const index of failures) lines[index] = `FAILED tests/test_items.py::test_item_${index} - assert 1 == 2`;
lines[400] = 'item 400: uncertain detail that must remain available';
lines[1799] = 'Tests: 1795 passed, 5 failed';
const path = `/project/${'nested-directory/'.repeat(8)}full.txt`;
const input = { command: 'pytest -vv', goal: 'Report failures and totals.', output: lines.join('\n'), fullOutputPath: path };
const asker: JevAsker = {
  async ask(state, questions) {
    const { chunks } = state as { chunks: { id: string; text: string }[] };
    return {
      answers: Object.fromEntries(chunks.filter(chunk => chunk.id in questions).map(chunk => [
        chunk.id, { noul: chunk.text.includes('uncertain detail') ? 0.11 : 0.01 },
      ])),
    };
  },
};

describe('compact omission metadata', () => {
  it.each([
    ['test_cart.py::test_regular_total[0] PASSED [  0%]', 'progress'],
    ['================ 1800 passed in 2.3s ================', 'result'],
    ['================ 1799 passed, 1 failed in 2.3s ================', 'diagnostic'],
    ['src/settings.ts(1,14): error TS2322: Type string is not assignable to number.', 'diagnostic'],
    ['E       assert 7 == 10', 'diagnostic'],
  ])('classifies real runner output: %s', (line, category) => {
    expect(isProtectedLine(line)).toBe(category !== 'progress');
    expect(classifyInformation(line)).toBe(category);
  });

  it('fits preserved facts and uncertainty by removing repeated archive references', async () => {
    const legacy = await trimOutput(input, asker, { maxChars: 2175 });
    const result = await trimOutput(input, asker, { maxChars: 2175, compactMarkers: true });
    expect(legacy.trimmed).toBe(false);
    expect(result.trimmed).toBe(true);
    expect(result.charsAfter).toBeLessThanOrEqual(2175);
    expect(result.output.split(path)).toHaveLength(2);
    expect(result.output).toContain('retained lines verbatim; omissions marked');
    for (const index of [0, 400, 1799, ...failures.flatMap(at => [at - 1, at, at + 1])]) {
      expect(result.output).toContain(lines[index]);
    }
  });

  it('still fails open when protected content cannot fit', async () => {
    const result = await trimOutput(input, asker, { maxChars: 700, compactMarkers: true });
    expect(result.trimmed).toBe(false);
    expect(result.output).toBe(input.output);
  });
});
