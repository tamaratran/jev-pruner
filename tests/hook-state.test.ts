import { describe, expect, it, vi } from 'vitest';
import type { MatchedHook } from 'claude-code';
import { register } from '../hooks/fast-jev-output.js';
import type { HookConfig, HookFetchInit } from '../hooks/fast-jev-output.js';
import type { ConversationMessage } from '../src/history.js';
import type { JevQuestions } from '../src/jev.js';

type BashHook = MatchedHook<'tool.call', { tool: 'Bash' }>;

function harness(options: Partial<HookConfig> = {}) {
  const on = vi.fn();
  register(on, { apiKey: 'mock-key', ...options });
  expect(on).toHaveBeenCalledWith('tool.call', { tool: 'Bash' }, expect.any(Function));
  const hook = on.mock.calls[0]![2] as BashHook;
  const messages: ConversationMessage[] = [
    { role: 'user', text: 'Keep artifact alpha.', toolUses: [] },
    { role: 'assistant', text: 'Alpha is needed for deployment.', toolUses: [] },
    ...['Continue.', 'Run checks.', 'Build now.'].map((text) => ({
      role: 'user' as const, text, toolUses: [],
    })),
  ];
  const bodies: string[] = [];
  const fetch = vi.fn(async (_url: string, init?: HookFetchInit) => {
    bodies.push(init?.body ?? '');
    const { questions } = JSON.parse(init?.body ?? '{}') as { questions: JevQuestions };
    return {
      status: 200,
      ok: true,
      text: JSON.stringify({
        answers: Object.fromEntries(Object.keys(questions).map((id) => [id, { noul: 0.1 }])),
      }),
    };
  });
  const readMessages = vi.fn(async () => messages);
  const write = vi.fn(async (_path: string, _content: string) => {});
  const host = {
    session: { messages: readMessages },
    http: { fetch },
    fs: { exists: async () => false, write },
    ui: { log: vi.fn(), toast: vi.fn() },
  };
  const original = {
    result: {
      stdout: Array.from({ length: 200 }, (_, i) => `compiled module ${i} successfully`).join('\n'),
      stderr: 'stderr stays intact',
      interrupted: false,
    },
  };
  const next = vi.fn(async () => original);
  return {
    bodies, messages, readMessages, fetch, write, original, next,
    run: () => hook(
      host as unknown as Parameters<BashHook>[0],
      { tool: 'Bash', command: 'build', tool_use_id: 'bash-test' },
      next as unknown as Parameters<BashHook>[2],
    ),
  };
}

describe('Bash hook conversation state', () => {
  it('reads fresh history per command and includes it in the actual HTTP body', async () => {
    const h = harness();
    const first = await h.run();
    expect(h.next).toHaveBeenCalledOnce();
    expect(h.readMessages).toHaveBeenCalledOnce();
    expect(JSON.parse(h.bodies[0]!)).toMatchObject({
      state: {
        task: 'Continue.\nRun checks.\nBuild now.',
        history: expect.arrayContaining([
          { i: 0, role: 'user', text: 'Keep artifact alpha.' },
          { i: 1, role: 'assistant', text: 'Alpha is needed for deployment.' },
        ]),
      },
    });
    expect(first.result).toMatchObject({ stderr: h.original.result.stderr });
    expect(h.write).toHaveBeenCalledWith(expect.stringContaining('bash-test.txt'), expect.any(String));
    h.messages.push({ role: 'user', text: 'Also keep beta.', toolUses: [] });
    await h.run();
    expect(h.readMessages).toHaveBeenCalledTimes(2);
    expect(h.bodies[1]).toContain('Also keep beta.');
  });

  it('returns the original result if the history cannot fit', async () => {
    const h = harness({ maxStateTokens: 10 });
    expect(await h.run()).toBe(h.original);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('returns the original result if reading history fails', async () => {
    const h = harness();
    h.readMessages.mockRejectedValueOnce(new Error('transcript unavailable'));
    expect(await h.run()).toBe(h.original);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });
});

describe('Bash output archives', () => {
  it('saves complete output before scoring and appends its reference after the last retained line', async () => {
    const h = harness({ chunkLines: 1 });
    const path = '.claude/fast-jev-output/bash-bash-test.txt';
    let releaseArchive!: () => void;
    const archiveReady = new Promise<void>((resolve) => { releaseArchive = resolve; });
    h.write.mockImplementation(async (file) => {
      if (file === path) await archiveReady;
    });
    const pending = h.run();
    await vi.waitFor(() => expect(h.write).toHaveBeenCalledTimes(2));
    expect(h.fetch).not.toHaveBeenCalled();
    releaseArchive();
    const result = await pending;
    const archiveWrites = h.write.mock.calls.filter(([file]) => file === path);
    expect(archiveWrites).toEqual([[path, `${h.original.result.stdout}\n${h.original.result.stderr}`]]);
    const archiveIndex = h.write.mock.calls.findIndex(([file]) => file === path);
    expect(h.write.mock.invocationCallOrder[archiveIndex]).toBeLessThan(h.fetch.mock.invocationCallOrder[0]!);
    expect(h.fetch.mock.calls.length).toBeGreaterThan(1);
    expect(result.result).toMatchObject({
      stdout: expect.stringMatching(
        /compiled module 199 successfully\n\n\[fast-jev-output full output: \.claude\/fast-jev-output\/bash-bash-test\.txt \(Read or grep it if needed\)\]$/,
      ),
      stderr: h.original.result.stderr,
    });
  });

  it('leaves output intact without scoring if the archive cannot be written', async () => {
    const h = harness();
    h.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk full'));
    expect(await h.run()).toBe(h.original);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not archive credential-like output or advertise a saved file', async () => {
    const h = harness();
    h.original.result.stdout += '\npassword=synthetic-test-value';
    const result = await h.run();
    expect(h.write).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalled();
    expect(result.result).toMatchObject({ stdout: expect.stringContaining('not saved to disk') });
    expect(result.result).not.toMatchObject({ stdout: expect.stringContaining('full output:') });
  });
});
