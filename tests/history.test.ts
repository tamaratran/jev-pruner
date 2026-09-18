import { describe, expect, it } from 'vitest';
import { fitHistory } from '../src/history.js';
import type { ConversationMessage } from '../src/history.js';
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
    message('assistant', 'Alpha is needed for the deployment.', {
      toolUses: [{
        tool_use_id: 'read-1',
        tool: 'Read',
        input: { file_path: 'artifacts.txt' },
        text: 'EMBEDDED_OUTPUT',
        result: { content: 'RAW_EMBEDDED_RESULT' },
      }],
    }),
    message('user', 'Also check the deployment manifest.', {
      toolResults: [{
        tool_use_id: 'read-1',
        text: 'RESULT_BODY',
        result: { content: 'RAW_RESULT_BODY' },
        isError: true,
      }],
    }),
    message('assistant', '', {
      toolUses: [{
        tool_use_id: 'read-2',
        tool: 'Read',
        input: { file_path: 'manifest.txt' },
        text: 'EMBEDDED_ONLY_OUTPUT',
      }],
    }),
    message('user', 'Continue.'),
    message('user', 'Run the checks.'),
    message('user', 'Then build.'),
    message('assistant', '', {
      toolUses: [{ tool_use_id: 'bash-1', tool: 'Bash', input: { command: 'build' } }],
    }),
  ];
}

describe('conversation history', () => {
  it('retains ordered text and tool inputs but neither representation of result bodies', () => {
    const messages = transcript();
    const original = structuredClone(messages);
    const history = fitHistory(messages, 25_000);
    expect(history.map(({ i, role, text }) => ({ i, role, text }))).toEqual(
      messages.map(({ role, text }, i) => ({ i, role, text })),
    );
    expect(history[1]?.tool_calls).toEqual([{
      id: 't1',
      tool: 'Read',
      input: '{"file_path":"artifacts.txt"}',
      result: 'error, 11 chars (omitted)',
    }]);
    expect(history[3]?.tool_calls?.[0]?.result).toBe('ok, 20 chars (omitted)');
    expect(history.at(-1)?.tool_calls?.[0]?.result).toBe('pending');
    expect(JSON.stringify(history)).not.toMatch(/EMBEDDED_OUTPUT|RAW_EMBEDDED_RESULT|RESULT_BODY|EMBEDDED_ONLY_OUTPUT/);
    expect(messages).toEqual(original);
  });

  it('omits result-only entries while retaining text beside tool results', () => {
    const messages = [
      ...transcript(),
      message('user', '', { toolResults: [{ tool_use_id: 'bash-1', text: 'build output' }] }),
    ];
    const history = fitHistory(messages, 25_000);
    expect(history).toHaveLength(messages.length - 1);
    expect(history[2]?.text).toBe('Also check the deployment manifest.');
    expect(history.at(-1)?.tool_calls?.[0]?.result).toBe('ok, 12 chars (omitted)');
  });

  it('fits large tool inputs without changing the original conversation', () => {
    const messages = [
      message('user', 'Keep alpha.'),
      ...Array.from({ length: 12 }, (_, i) => message('assistant', '', {
        toolUses: [{
          tool_use_id: `edit-${i}`,
          tool: 'Edit',
          input: { file_path: 'a.ts', new_string: 'long input '.repeat(1_000) },
        }],
      })),
      message('user', 'Build now.'),
    ];
    const original = structuredClone(messages);
    const history = fitHistory(messages, 1_800);
    expect(estimateStateTokens(JSON.stringify(history))).toBeLessThanOrEqual(1_800);
    expect(history[1]?.tool_calls?.[0]?.input.length).toBeLessThanOrEqual(200);
    expect(history[0]?.text).toBe('Keep alpha.');
    expect(history.at(-1)?.text).toBe('Build now.');
    expect(messages).toEqual(original);
  });

  it('abridges older long text before touching the first and recent messages', () => {
    const messages = [
      message('user', 'Original constraint.'),
      message('assistant', `older head ${'detail '.repeat(3_000)} older tail`),
      ...Array.from({ length: 6 }, (_, i) => message('user', `Recent instruction ${i}.`)),
    ];
    const history = fitHistory(messages, 1_000);
    expect(history[0]?.text).toBe(messages[0]?.text);
    expect(history[1]?.text).toMatch(/^older head .*chars omitted.*older tail$/s);
    expect(history.slice(-6).map((entry) => entry.text)).toEqual(
      messages.slice(-6).map((entry) => entry.text),
    );
    expect(estimateStateTokens(JSON.stringify(history))).toBeLessThanOrEqual(1_000);
  });

  it('bounds many old text-only messages while retaining the first and newest six', () => {
    const messages = Array.from({ length: 400 }, (_, i) => message('user', `instruction ${i}`));
    const history = fitHistory(messages, 1_000);
    expect(history.length).toBeLessThan(messages.length);
    expect(history[0]?.text).toBe('instruction 0');
    expect(history.slice(-6).map((entry) => entry.text)).toEqual(
      messages.slice(-6).map((entry) => entry.text),
    );
    expect(estimateStateTokens(JSON.stringify(history))).toBeLessThanOrEqual(1_000);
  });

  it.each(['user', 'assistant'] as const)('retains concise %s decisions before longer old text', (role) => {
    const decision = 'Use the release candidate and retain its manifest digest.';
    const messages = [
      message('user', 'Prepare the deployment.'),
      message(role, decision),
      ...Array.from({ length: 10 }, (_, i) => message('user', `Review ${i}: ${'background detail '.repeat(500)}`)),
      message(role, 'Use the stable rollback.'),
      ...Array.from({ length: 10 }, (_, i) => message('user', `More review ${i}: ${'background detail '.repeat(500)}`)),
      ...Array.from({ length: 6 }, (_, i) => message('user', `Recent instruction ${i}.`)),
    ];
    const original = structuredClone(messages);
    const history = fitHistory(messages, 1_400);
    expect(history.find(entry => entry.i === 1)?.text).toBe(decision);
    expect(history.find(entry => entry.i === 12)?.text).toBe('Use the stable rollback.');
    expect(history.some(entry => /^\[… \d+ chars omitted …\]$/.test(entry.text))).toBe(true);
    expect(history.map(entry => entry.i)).toEqual(history.map(entry => entry.i).sort((a, b) => a - b));
    expect(estimateStateTokens(JSON.stringify(history))).toBeLessThanOrEqual(1_400);
    expect(messages).toEqual(original);
  });

  it('does not enlarge short text into omission markers under a tight budget', () => {
    const messages = [
      message('user', 'Prepare the deployment.'),
      message('assistant', 'OK', {
        toolUses: [{ tool_use_id: 'read-1', tool: 'Read', input: { file_path: 'manifest.json' } }],
      }),
      ...Array.from({ length: 20 }, (_, i) => message('user', `Review ${i}: ${'background detail '.repeat(500)}`)),
      ...Array.from({ length: 6 }, (_, i) => message('user', `Recent instruction ${i}.`)),
    ];
    const history = fitHistory(messages, 500);
    expect(history.find(entry => entry.i === 1)?.text).toBe('OK');
    expect(history.length).toBeLessThan(messages.length);
    expect(estimateStateTokens(JSON.stringify(history))).toBeLessThanOrEqual(500);
  });

  it('rejects a budget that cannot hold the protected history', () => {
    expect(() => fitHistory([message('user', 'Keep alpha.')], 1)).toThrow('history too large');
  });
});

describe('history in output scoring', () => {
  const output = Array.from({ length: 200 }, (_, i) => `compiled module ${i}`).join('\n');

  function asker(states: JevState[], rejectFirst = false): JevAsker {
    return {
      async ask(state, questions) {
        states.push(state);
        if (rejectFirst && states.length === 1) throw new Error('max_tokens_exceeded');
        return {
          answers: Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'noul' as const, noul: 0.1 }]),
          ),
        };
      },
    };
  }

  it('sends earlier constraints, assistant decisions, and current output together', async () => {
    const states: JevState[] = [];
    await trimOutput(
      { command: 'build', goal: 'Then build.', output, messages: transcript() },
      asker(states),
      { minChars: 1 },
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      task: 'Then build.',
      command: 'build',
      history: fitHistory(transcript(), 25_000),
      chunks: expect.arrayContaining([expect.objectContaining({ id: 'c1' })]),
    });
    expect(JSON.stringify(states[0])).not.toMatch(/EMBEDDED_OUTPUT|RAW_EMBEDDED_RESULT|RESULT_BODY/);
  });

  it('shares the state budget with digit-heavy output on retries', async () => {
    const states: JevState[] = [];
    const messages = [
      message('user', 'Preserve artifact alpha.'),
      ...Array.from({ length: 100 }, (_, i) => message('assistant', `step ${i} ${'details '.repeat(80)}`)),
      message('user', 'Build now.'),
    ];
    const largeOutput = Array.from({ length: 8_000 }, (_, i) => `1234567890 module ${i}`).join('\n');
    await trimOutput(
      { command: 'build', goal: 'Build now.', output: largeOutput, messages },
      asker(states, true),
      { maxStateTokens: 12_000 },
    );
    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(estimateStateTokens(JSON.stringify(states[0]))).toBeLessThanOrEqual(12_000);
    for (const state of states.slice(1)) {
      expect(estimateStateTokens(JSON.stringify(state))).toBeLessThanOrEqual(6_000);
      expect(JSON.stringify(state)).toContain('Preserve artifact alpha.');
      expect(JSON.stringify(state)).toContain('Build now.');
    }
  });

  it('repeats the same history in every question batch', async () => {
    const states: JevState[] = [];
    const verboseOutput = Array.from(
      { length: 200 },
      (_, i) => `compiled module ${i} ${'noise '.repeat(50)}`,
    ).join('\n');
    await trimOutput(
      { command: 'build', goal: 'Then build.', output: verboseOutput, messages: transcript() },
      asker(states),
      { minChars: 1, chunkLines: 1 },
    );
    expect(states.length).toBeGreaterThan(1);
    for (const state of states) {
      expect(state).toBe(states[0]);
      expect(state).toMatchObject({ history: fitHistory(transcript(), 25_000) });
    }
  });

  it('leaves output untouched when the combined state cannot fit', async () => {
    const states: JevState[] = [];
    const result = await trimOutput(
      { command: 'build', goal: 'x'.repeat(10_000), output, messages: [] },
      asker(states),
      { minChars: 1, maxStateTokens: 100 },
    );
    expect(states).toHaveLength(0);
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
  });
});
