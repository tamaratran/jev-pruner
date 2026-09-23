import { describe, expect, it } from 'vitest';
import { convert, keptLines, repositoryFor, selectedOutputLines } from '../training/prepare.mjs';
import { parseDrops } from '../training/review.mjs';

function source(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    instance_id: 'mswe_python_example__project-42', step_idx: 3,
    history: [{ role: 'user', content: 'Fix the failing build; keep failure evidence and totals.' }],
    tool_call: { name: 'execute_bash', arguments: { command: 'npm run build' } },
    tool_response: [...Array.from({ length: 20 }, (_, i) => `Downloading ${i}%`),
      'Error: Cannot find module ./auth', '2 tests failed'].join('\n'),
    kept_frags: [21], _confidence: 'confident', next_turn: 'FUTURE_SENTINEL',
    _reasoning: 'RATIONALE_SENTINEL', ...overrides,
  });
}

describe('Kev training conversion', () => {
  it('groups repository aliases and related issues before partitioning', () => {
    expect(repositoryFor('Azure_msrest-for-python_pr218')).toBe('azure/msrest-for-python');
    expect(repositoryFor('mswe_python_Azure__msrest-for-python-247')).toBe('azure/msrest-for-python');
    expect(() => repositoryFor('unknown-format')).toThrow();
    expect(() => repositoryFor('ccbench_unknown-model-42')).toThrow();
  });
  it('keeps the entire chunk if one source line or diagnostic needs retention', () => {
    const record = convert(source(), 1)!;
    expect(record.candidateDrops).toEqual(['c1']);
    expect(record.questions.c2!.criteria!.true).toContain('One needed line');
    expect(record.state.chunks[1]!.text).toContain('Cannot find module');
  });

  it('never makes uncertain source annotations into automatic negatives', () => {
    expect(convert(source({ _confidence: 'skeleton', kept_frags: [] }), 1)!.candidateDrops).toEqual([]);
  });

  it('does not use future fields to build or select the model input', () => {
    const first = convert(source(), 1)!;
    const changed = convert(source({ next_turn: 'DIFFERENT_FUTURE', _reasoning: 'DIFFERENT_REASON' }), 1)!;
    expect(changed.state).toEqual(first.state);
    expect(changed.id).toEqual(first.id);
    expect(JSON.stringify(first.state)).not.toMatch(/FUTURE_SENTINEL|RATIONALE_SENTINEL|kept_frags|_confidence/);
  });

  it('does not fabricate a task when the source lacks user instructions', () => {
    expect(convert(source({ history: [{ role: 'assistant', content: 'Running tests.' }] }), 1)).toBeNull();
  });

  it('preserves prior assistant tool calls with no text body', () => {
    const record = convert(source({ history: [
      { role: 'user', content: 'Fix the build.' },
      { role: 'assistant', tool_calls: [{ name: 'execute_bash', arguments: { command: 'npm test' } }] },
    ] }), 1)!;
    expect(JSON.stringify(record.state.history)).toContain('npm test');
  });

  it('rejects invalid line ranges and avoids misaligning wrapped source lines', () => {
    expect([...keptLines(['1-3', 5], 5)]).toEqual([1, 2, 3, 5]);
    expect(() => keptLines(['3-9'], 5)).toThrow();
    expect(() => keptLines([0], 5)).toThrow();
    expect(() => keptLines([1.5], 5)).toThrow();
    expect(convert(source({ tool_response: 'x'.repeat(2001), kept_frags: [1] }), 1)).toBeNull();
  });

  it('maps Python splitlines annotations onto the pruner newline boundaries', () => {
    expect([...selectedOutputLines('progress\rother\nfailure\r\nsummary\n', [3, 4])]).toEqual([2, 3]);
    expect([...selectedOutputLines('a\u2028b\nc', [2])]).toEqual([1]);
    expect(() => selectedOutputLines('a\n', [2])).toThrow();
  });
});

describe('policy review', () => {
  it('requires a valid candidate ID and justification for every proposed drop', () => {
    expect(parseDrops('{"drops":[]}', ['c1'])).toEqual([]);
    expect(() => parseDrops('{"drops":[{"id":"c2","reason":"noise"}]}', ['c1'])).toThrow();
    expect(() => parseDrops('{"drops":[{"id":"c1","reason":""}]}', ['c1'])).toThrow();
    expect(() => parseDrops('{"drops":[{"id":"c1","reason":"noise"},{"id":"c1","reason":"noise"}]}', ['c1'])).toThrow();
  });
});
