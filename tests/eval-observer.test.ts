import { describe, expect, it, vi } from 'vitest';
import type { BuiltinToolResults, MatchedHook } from 'claude-code';
import { register } from '../evals/observer/hooks/observer.js';

type BashHook = MatchedHook<'tool.call', { tool: 'Bash' }>;

describe('evaluation archive capture', () => {
  it.each([
    '/opt/jev-eval/auth/.credentials.json',
    '/opt/jev-eval/login/.credentials.json',
    '/opt/jev-eval/auth/projects/../../.credentials.json',
    '/private/claude/projects/task/tool-results/output.txt',
    '.claude/fast-jev-output/bash-tool-id.txt',
  ])('never reads a footer path %s or changes the tool result', async path => {
    const on = vi.fn();
    register(on, {});
    const hook = on.mock.calls.find(([event]) => event === 'tool.call')![2] as BashHook;
    const read = vi.fn(async () => 'complete original output');
    const write = vi.fn(async (_path: string, _text: string) => {});
    const answer: { result: BuiltinToolResults['Bash'] } = {
      result: {
        stdout: `shortened\n[fast-jev-output full output: ${path} (Read or grep it if needed)]`,
        stderr: '',
        interrupted: false,
      },
    };
    const next = vi.fn(async () => answer);
    const result = await hook(
      { fs: { read, write } } as unknown as Parameters<BashHook>[0],
      { tool: 'Bash', command: 'build', tool_use_id: 'tool-id' },
      next as unknown as Parameters<BashHook>[2],
    );
    expect(result).toBe(answer);
    expect(next).toHaveBeenCalledOnce();
    expect(read).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toBe('/logs/agent/jev/bash-1.json');
  });
});
