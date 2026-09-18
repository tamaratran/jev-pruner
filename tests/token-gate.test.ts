import { describe, expect, it, vi } from 'vitest';
import type { MatchedHook } from 'claude-code';
import { register, resolveHookConfig } from '../hooks/fast-jev-output.js';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

const outputWithTokens = (tokens: number) => Array.from({ length: tokens }, () => 'cache').join('\n');

describe('output token gate', () => {
  it.each([9_999, 10_000])('leaves %i tokens untouched without scoring', async (tokens) => {
    const output = outputWithTokens(tokens);
    const ask = vi.fn();
    expect(estimateTokens(output)).toBe(tokens);
    const result = await trimOutput({ command: 'build', goal: '', output }, { ask });
    expect(result.output).toBe(output);
    expect(result.trimmed).toBe(false);
    expect(ask).not.toHaveBeenCalled();
  });

  it('scores output strictly above 10,000 tokens', async () => {
    const ask = vi.fn(async (_state: JevState, questions: JevQuestions) => ({
      answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
    }));
    const output = outputWithTokens(10_001);
    expect(estimateTokens(output)).toBe(10_001);
    const result = await trimOutput({ command: 'build', goal: '', output }, { ask });
    expect(ask).toHaveBeenCalled();
    expect(result.trimmed).toBe(true);
  });

  it('cannot lower the gate through current or legacy configuration', async () => {
    expect(resolveHookConfig({ minTokens: 1, minChars: 0 }).minTokens).toBe(10_000);
    const ask = vi.fn();
    await trimOutput(
      { command: 'build', goal: '', output: outputWithTokens(10_000) },
      { ask },
      { minTokens: 0 },
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it('allows increasing the token threshold', async () => {
    const ask = vi.fn();
    await trimOutput(
      { command: 'build', goal: '', output: outputWithTokens(10_001) },
      { ask },
      { minTokens: 20_000 },
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it('skips history, archives and HTTP for small stdout even with large stderr', async () => {
    type BashHook = MatchedHook<'tool.call', { tool: 'Bash' }>;
    const on = vi.fn();
    register(on, { apiKey: 'mock-key' });
    const hook = on.mock.calls[0]![2] as BashHook;
    const messages = vi.fn();
    const fetch = vi.fn();
    const write = vi.fn();
    const original = {
      result: { stdout: outputWithTokens(10_000), stderr: outputWithTokens(20_000), interrupted: false },
    };
    const result = await hook(
      { session: { messages }, http: { fetch }, fs: { write } } as unknown as Parameters<BashHook>[0],
      { tool: 'Bash', command: 'build', tool_use_id: 'gate' },
      (async () => original) as unknown as Parameters<BashHook>[2],
    );
    expect(result).toBe(original);
    expect(messages).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});
