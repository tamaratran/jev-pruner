import { describe, expect, it } from 'vitest';
import { historyEntries, splitHistory } from '../src/history.js';
import type { ConversationMessage, HistoryEntry } from '../src/history.js';
import { estimateStateTokens } from '../src/jev.js';
import type { JevAsker, JevState } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

function message(
  role: ConversationMessage['role'],
  text: string,
  extra: Partial<ConversationMessage> = {},
): ConversationMessage {
  return { role, text, toolUses: [], ...extra };
}

function transcript(): ConversationMessage[] {
  return [
    message('user', 'Preserve artifact alpha even if the build is successful.'),
    message('assistant', 'Alpha is needed for deployment.', {
      toolUses: [{
        tool_use_id: 'read-1', tool: 'Read', input: { file_path: 'artifacts.txt' },
        text: 'EMBEDDED_OUTPUT', result: { content: 'RAW_EMBEDDED_RESULT' },
      }],
    }),
    message('user', 'Also check the deployment manifest.', {
      toolResults: [{
        tool_use_id: 'read-1', text: 'RESULT_BODY',
        result: { content: 'RAW_RESULT_BODY' }, isError: true,
      }],
    }),
    message('assistant', '', {
      toolUses: [{ tool_use_id: 'bash-1', tool: 'Bash', input: { command: 'build' } }],
    }),
  ];
}

describe('conversation history partitions', () => {
  it('includes ordered text, full tool inputs and both result representations', () => {
    const messages = transcript();
    const original = structuredClone(messages);
    const segments = splitHistory(messages, 25_000);
    expect(segments).toHaveLength(1);
    const history = segments[0]!;
    expect(history.map(({ i, role, text }) => ({ i, role, text }))).toEqual(
      messages.map(({ role, text }, i) => ({ i, role, text })),
    );
    expect(history[1]?.tool_calls?.[0]).toMatchObject({
      id: 'read-1', tool: 'Read', input: '{"file_path":"artifacts.txt"}',
    });
    expect(JSON.parse(history[1]!.tool_calls![0]!.result)).toEqual({
      text: 'EMBEDDED_OUTPUT', data: { content: 'RAW_EMBEDDED_RESULT' }, isError: false,
    });
    expect(JSON.parse(history[2]!.tool_results![0]!.result)).toEqual({
      text: 'RESULT_BODY', data: { content: 'RAW_RESULT_BODY' }, isError: true,
    });
    expect(history.at(-1)?.tool_calls?.[0]?.result).toBe('pending');
    expect(messages).toEqual(original);
  });

  it('deduplicates identical results and keeps orphan/result-only entries', () => {
    const body = { text: 'actual output', result: { exitCode: 1 }, isError: true };
    const messages = [
      message('assistant', '', {
        toolUses: [{ tool_use_id: 'call', tool: 'Bash', input: {}, ...body }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 'call', ...body }] }),
      message('user', '', { toolResults: [{ tool_use_id: 'orphan', text: 'older output' }] }),
    ];
    const history = splitHistory(messages, 25_000).flat();
    expect(history).toHaveLength(3);
    expect(history[0]?.tool_calls?.[0]?.result).toBe('see tool_results with this id');
    expect(JSON.stringify(history).match(/actual output/g)).toHaveLength(1);
    expect(history[2]?.tool_results?.[0]?.result).toContain('older output');
  });

  it('preserves all messages and concise decisions under tight budgets', () => {
    const messages = [
      message('user', 'Original constraint.'),
      message('assistant', 'Use stable rollback.'),
      ...Array.from({ length: 100 }, (_, i) => message('user', `Review ${i}: ${'detail '.repeat(300)}`)),
      message('user', 'Build now.'),
    ];
    const original = structuredClone(messages);
    const segments = splitHistory(messages, 500);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) {
      expect(estimateStateTokens(JSON.stringify(segment))).toBeLessThanOrEqual(500);
    }
    for (let i = 0; i < messages.length; i++) {
      expect(segments.flat().filter(entry => entry.i === i).map(entry => entry.text).join(''))
        .toBe(messages[i]!.text);
    }
    expect(messages).toEqual(original);
  });

  it.each([300, 1_800])('splits oversized text, inputs and results losslessly at %i tokens', (budget) => {
    const text = ('unicode 😀 \\ " 1234567890\n').repeat(700);
    const messages = [
      message('assistant', text, {
        toolUses: [{
          tool_use_id: 'edit', tool: 'Edit', input: { new_string: text },
          text, result: { value: text },
        }],
      }),
      message('user', '', { toolResults: [{ tool_use_id: 'orphan', text, result: { value: text } }] }),
    ];
    const source = historyEntries(messages);
    const segments = splitHistory(messages, budget);
    const fragments = segments.flat();
    expect(segments.length).toBeGreaterThan(2);
    expect(segments.every(segment => estimateStateTokens(JSON.stringify(segment)) <= budget)).toBe(true);
    const join = (i: number, field: NonNullable<HistoryEntry['part']>['field']) => {
      let offset = 0;
      return fragments.filter(entry => entry.i === i && entry.part?.field === field).map(entry => {
        const value = field === 'text' ? entry.text
          : field === 'tool_calls.input' ? entry.tool_calls![0]!.input
          : field === 'tool_calls.result' ? entry.tool_calls![0]!.result
          : entry.tool_results![0]!.result;
        expect(entry.part!.offset).toBe(offset);
        expect(value).not.toMatch(/[\uD800-\uDBFF]$/);
        offset += value.length;
        return value;
      }).join('');
    };
    expect(join(0, 'text')).toBe(text);
    expect(join(0, 'tool_calls.input')).toBe(source[0]!.tool_calls![0]!.input);
    expect(join(0, 'tool_calls.result')).toBe(source[0]!.tool_calls![0]!.result);
    expect(join(1, 'tool_results.result')).toBe(source[1]!.tool_results![0]!.result);
  });

  it('rejects a budget too small even for fragment metadata', () => {
    expect(() => splitHistory([message('user', 'Keep alpha.')], 1)).toThrow('cannot fit');
  });
});

describe('history in output scoring', () => {
  const output = Array.from({ length: 200 }, (_, i) => `module ${i}: ${'cache '.repeat(55)}`).join('\n');

  it('sends full tool results with the earlier instructions and current output', async () => {
    const states: JevState[] = [];
    await trimOutput(
      { command: 'build', goal: 'Build now.', output, messages: transcript() },
      {
        async ask(state, questions) {
          states.push(state);
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])) };
        },
      },
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      task: 'Build now.', command: 'build', history: historyEntries(transcript()),
      chunks: expect.arrayContaining([expect.objectContaining({ id: 'c1' })]),
    });
  });

  it('asks every history segment in parallel and keeps the maximum vote', async () => {
    const messages = [
      message('user', 'Keep alpha.'),
      ...Array.from({ length: 30 }, (_, i) => message('assistant', `step ${i} ${'details '.repeat(200)}`)),
      message('user', '', { toolResults: [{ tool_use_id: 'read', text: 'REQUIRED_BY_TOOL_RESULT' }] }),
    ];
    const seen = new Map<string, Set<string>>();
    const releases: (() => void)[] = [];
    const asker: JevAsker = {
      async ask(state, questions) {
        const parsed = state as { history: HistoryEntry[]; chunks: { id: string; text: string }[] };
        const history = JSON.stringify(parsed.history);
        expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(4_000);
        expect(estimateStateTokens(JSON.stringify({ state, questions }))).toBeLessThanOrEqual(30_000);
        const ids = seen.get(history) ?? new Set<string>();
        Object.keys(questions).forEach(id => {
          ids.add(id);
          expect(parsed.chunks.some(chunk => chunk.id === id)).toBe(true);
        });
        seen.set(history, ids);
        await new Promise<void>(resolve => releases.push(resolve));
        return {
          answers: Object.fromEntries(Object.keys(questions).map(id => [
            id, { noul: id === 'c4' && history.includes('REQUIRED_BY_TOOL_RESULT') ? 0.9 : 0.1 },
          ])),
        };
      },
    };
    const pending = trimOutput(
      { command: 'build', goal: 'Build now.', output, messages }, asker, { maxStateTokens: 4_000 },
    );
    expect(seen.size).toBeGreaterThan(2);
    expect(releases.length).toBeGreaterThan(seen.size);
    releases.forEach(release => release());
    const result = await pending;
    for (const ids of seen.values()) expect([...ids].sort()).toEqual(
      Array.from({ length: 10 }, (_, i) => `c${i + 1}`).sort(),
    );
    expect([...seen.keys()].join('')).toContain('Keep alpha.');
    expect([...seen.keys()].join('')).toContain('REQUIRED_BY_TOOL_RESULT');
    expect(result.scores[3]).toBe(0.9);
    expect(result.output).toContain('module 65:');
    expect(result.output).not.toContain('module 105:');
    expect(result.trimmed).toBe(true);
  });

  it('does not prune on incomplete history-segment responses', async () => {
    const messages = Array.from({ length: 20 }, (_, i) => message('user', `${i} ${'details '.repeat(300)}`));
    let calls = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        calls++;
        if (calls === 2) return { answers: {} };
        return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])) };
      },
    };
    await expect(trimOutput(
      { command: 'build', goal: '', output, messages }, asker, { maxStateTokens: 4_000 },
    )).rejects.toThrow('Invalid Jev answer');
    expect(calls).toBeGreaterThan(2);
  });

  it('repartitions all history on context-limit retries without losing results', async () => {
    const seen: { history: HistoryEntry[]; chunks: { id: string }[] }[] = [];
    let retry = false;
    const messages = [
      message('user', 'First requirement.'),
      message('user', '', { toolResults: [{ tool_use_id: 'read', text: 'tool value '.repeat(5_000) }] }),
      message('assistant', 'Last decision.'),
    ];
    const result = await trimOutput(
      { command: 'build', goal: '', output, messages },
      {
        async ask(state, questions) {
          if (!retry) { retry = true; throw new Error('max_tokens_exceeded'); }
          seen.push(state as (typeof seen)[number]);
          return { answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])) };
        },
      },
      { maxStateTokens: 12_000 },
    );
    const retried = seen.filter(state => estimateStateTokens(JSON.stringify(state)) <= 6_000);
    const histories = [...new Map(retried.map(state => [JSON.stringify(state.history), state.history])).values()];
    const toolParts = histories.flat().filter(entry => entry.i === 1);
    expect(toolParts.map(entry => entry.tool_results?.[0]?.result ?? '').join(''))
      .toBe(historyEntries(messages)[1]!.tool_results![0]!.result);
    expect(JSON.stringify(histories)).toContain('First requirement.');
    expect(JSON.stringify(histories)).toContain('Last decision.');
    expect(result.trimmed).toBe(true);
  });

  it('leaves output untouched when fixed state fields cannot fit', async () => {
    let calls = 0;
    const result = await trimOutput(
      { command: 'build', goal: 'x'.repeat(10_000), output },
      { async ask() { calls++; return { answers: {} }; } },
      { maxStateTokens: 100 },
    );
    expect(calls).toBe(0);
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});
