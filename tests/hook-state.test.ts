import { describe, expect, it, vi } from 'vitest';
import type { BuiltinToolResults, MatchedHook } from 'claude-code';
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
  const read = vi.fn(async (_path: string) => '');
  const write = vi.fn(async (_path: string, _content: string) => {});
  const host = {
    session: { messages: readMessages },
    http: { fetch },
    fs: { exists: async () => false, read, write },
    ui: { log: vi.fn(), toast: vi.fn() },
  };
  const original: { result: BuiltinToolResults['Bash']; text?: string } = {
    result: {
      stdout: Array.from({ length: 200 }, (_, i) => `${'cache '.repeat(55)}compiled module ${i} successfully`).join('\n'),
      stderr: 'stderr stays intact',
      interrupted: false,
    },
  };
  const next = vi.fn(async () => original);
  return {
    bodies, messages, readMessages, read, fetch, write, original, next, log: host.ui.log,
    run: (command = 'build') => hook(
      host as unknown as Parameters<BashHook>[0],
      { tool: 'Bash', command, tool_use_id: 'bash-test' },
      next as unknown as Parameters<BashHook>[2],
    ),
};
}

describe('Bash pruning diagnostics', () => {
  it.each([
    [2048, 8],
    [2146, 9],
    [8000, 12],
  ])('bounds scoring using a %i-character preview instead of archive size', async (size, limit) => {
    const h = harness({ diagnostics: true });
    h.original.result.persistedOutputPath = '/project/full.txt';
    h.read.mockResolvedValue(h.original.result.stdout);
    h.original.result.stdout = 'preview';
    h.original.text = 'p'.repeat(size);
    await h.run();
    expect(h.fetch.mock.calls.length).toBeGreaterThan(0);
    expect(h.fetch.mock.calls.length).toBeLessThanOrEqual(limit);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining(`"requestLimit":${limit}`));
  });

  it('shares a configured one-call allowance with token-limit retries', async () => {
    const h = harness({ diagnostics: true, maxScoringRequests: 0 });
    h.fetch.mockResolvedValue({ status: 400, ok: false, text: 'max_tokens_exceeded' });
    expect(await h.run()).toBe(h.original);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('"requestLimit":1'));
  });

  it('preserves an unscored tail when its preview only permits one request', async () => {
    const h = harness({ diagnostics: true });
    const full = Array.from({ length: 4000 }, (_, i) =>
      `progress ${i} ${'cached '.repeat(30)}`).join('\n') + '\nserial=important-tail';
    h.original.result.persistedOutputPath = '/project/full.txt';
    h.original.text = 'p'.repeat(250);
    h.read.mockResolvedValue(full);
    expect(await h.run()).toBe(h.original);
    expect(h.fetch.mock.calls.length).toBeLessThanOrEqual(1);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('"requestLimit":1'));
  });

  it.each([0, 8_000])('caps persisted replacements at the native visible size with budget %i', async persistedMaxChars => {
    const h = harness({ diagnostics: true, chunkChars: 4_000, persistedMaxChars });
    const complete = `${h.original.result.stdout}\nERROR: deployment blocked`;
    h.original.result.persistedOutputPath = '/project/complete-log.txt';
    h.original.result.stdout = 'host stdout preview '.repeat(1500);
    h.original.text = 'native preview '.repeat(150);
    h.read.mockResolvedValue(complete);
    const result = await h.run();
    expect(result).not.toBe(h.original);
    expect(result.result?.stdout.length).toBeLessThanOrEqual(h.original.text.length);
    expect(result.result?.stdout).toContain('ERROR: deployment blocked');
    expect(result.result?.stdout).toContain('full output: /project/complete-log.txt');
    expect(result.result?.stderr).toBe('');
    expect(h.write).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('"modelVisibleBudgetChars":2250'));
  });

  it.each(['', 'tiny'])('retains native output without scoring when its visible budget cannot fit a footer', async text => {
    const h = harness({ diagnostics: true });
    h.original.result.persistedOutputPath = '/project/complete-log.txt';
    h.original.text = text;
    h.read.mockResolvedValue(h.original.result.stdout);
    expect(await h.run()).toBe(h.original);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('"decision":"footer_exceeds_budget"'));
  });

  it('records small-output skips without history, network or output text', async () => {
    const h = harness({ diagnostics: true });
    h.original.result.stdout = 'synthetic private content';
    h.original.text = 'native rendered text';
    expect(await h.run()).toBe(h.original);
    const text = h.log.mock.calls[0]![0] as string;
    expect(JSON.parse(text.slice('fast-jev-output decision '.length))).toMatchObject({
      decision: 'below_threshold', requests: 0, sourceChars: 25,
      modelVisibleCharsBefore: 20, hookStdoutCharsBefore: 25, hookStdoutCharsAfter: 25,
    });
    expect(text).not.toContain('synthetic private');
    expect(h.readMessages).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('skips protected documents before reading history', async () => {
    const h = harness({ diagnostics: true });
    h.original.result.stdout = JSON.stringify({ data: 'cache '.repeat(12_000) });
    expect(await h.run()).toBe(h.original);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining('"decision":"document"'));
    expect(h.readMessages).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('distinguishes the archived source, hook preview and native visible text', async () => {
    const h = harness({ diagnostics: true, chunkChars: 4_000 });
    const complete = h.original.result.stdout;
    h.original.result.persistedOutputPath = '/project/output.txt';
    h.original.result.stdout = 'preview';
    h.original.text = 'native preview with file reference'.repeat(60);
    h.read.mockResolvedValue(complete);
    const result = await h.run();
    const text = h.log.mock.calls.at(-1)![0] as string;
    const decision = JSON.parse(text.slice('fast-jev-output decision '.length));
    expect(decision).toMatchObject({
      decision: 'pruned', persisted: true, sourceChars: complete.length,
      hookStdoutCharsBefore: 7, hookStdoutCharsAfter: result.result?.stdout.length,
      modelVisibleCharsBefore: h.original.text.length, modelVisibleBudgetChars: h.original.text.length,
      requests: h.fetch.mock.calls.length,
    });
    expect(decision.sourceChars).toBeGreaterThan(decision.hookStdoutCharsAfter);
    expect(decision.hookStdoutCharsAfter).toBeLessThanOrEqual(decision.modelVisibleCharsBefore);
  });

  it('retains the original result and identifies scoring failures', async () => {
    const h = harness({ diagnostics: true });
    h.fetch.mockRejectedValue(new Error('unavailable'));
    expect(await h.run()).toBe(h.original);
    expect(h.log.mock.calls.at(-1)![0]).toContain('"decision":"hook_error","stage":"scoring"');
  });

  it('ignores diagnostic logger failures', async () => {
    const h = harness({ diagnostics: true });
    h.original.result.stdout = 'short';
    h.log.mockImplementation(() => { throw new Error('logger unavailable'); });
    expect(await h.run()).toBe(h.original);
  });
});

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

  it('keeps the original output if one parallel history query fails', async () => {
    const h = harness({ maxStateTokens: 6_000 });
    h.messages.push({
      role: 'user', text: '', toolUses: [],
      toolResults: [{ tool_use_id: 'prior-read', text: 'tool result detail '.repeat(4_000) }],
    });
    h.fetch.mockRejectedValueOnce(new Error('network unavailable'));
    expect(await h.run()).toBe(h.original);
    expect(h.fetch.mock.calls.length).toBeGreaterThan(1);
    expect(h.write.mock.calls.filter(([path]) => path.endsWith('bash-bash-test.txt'))).toHaveLength(1);
  });
});

describe('Bash output archives', () => {
  it('does not prune a large explicit recovery read again', async () => {
    const h = harness({ diagnostics: true });
    expect((await h.run()).result?.stdout).toContain('fast-jev-output trimmed');
    const requests = h.fetch.mock.calls.length;
    expect(await h.run('sed -n "1,2000p" .claude/fast-jev-output/bash-bash-test.txt')).toBe(h.original);
    expect(h.fetch).toHaveBeenCalledTimes(requests);
    expect(h.log.mock.calls.at(-1)![0]).toContain('"decision":"archive_recovery"');
    await h.run('build');
    expect(h.fetch.mock.calls.length).toBeGreaterThan(requests);
  });

  it('counts the archive footer in the saved-output budget', async () => {
    const h = harness({ persistedMaxChars: 8_000 });
    const complete = h.original.result.stdout;
    const path = `/project/${'nested-dir/'.repeat(20)}output.txt`;
    h.original.result.persistedOutputPath = path;
    h.original.result.stdout = 'short host preview';
    h.read.mockResolvedValue(complete);
    const result = await h.run();
    expect(result).not.toBe(h.original);
    expect(result.result?.stdout.length).toBeLessThanOrEqual(8_000);
    expect(result.result?.stdout).toContain(`full output: ${path}`);
    expect(result.result).not.toHaveProperty('persistedOutputPath');
  });

  it('leaves saved output alone when persisted-output pruning is disabled', async () => {
    const h = harness({ persistedOutputs: false });
    h.original.result.persistedOutputPath = '/project/output.txt';
    expect(await h.run()).toBe(h.original);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('scores complete host-persisted output and reuses its archive', async () => {
    const h = harness();
    const complete = `${h.original.result.stdout}\n${h.original.result.stderr}`;
    const path = '/project/.claude/tool-results/large-output.txt';
    h.original.result.persistedOutputPath = path;
    h.original.result.persistedOutputSize = complete.length;
    h.original.result.stdout = 'short host preview';
    h.original.result.stderr = '';
    h.read.mockResolvedValue(complete);
    const result = await h.run();
    expect(h.read).toHaveBeenCalledWith(path);
    expect(h.write).not.toHaveBeenCalled();
    expect(h.fetch).toHaveBeenCalled();
    expect(result.result).toMatchObject({ stdout: expect.stringContaining('stderr stays intact') });
    expect(result.result).toMatchObject({
      stdout: expect.stringContaining(`[fast-jev-output full output: ${path} (Read or grep it if needed)]`),
    });
    expect(result.result).not.toHaveProperty('persistedOutputPath');
    expect(result.result).not.toHaveProperty('persistedOutputSize');
    expect(h.original.result.persistedOutputPath).toBe(path);
  });

  it.each(['small', 'unreadable', 'scoring fails'])('preserves the host archive when %s', async condition => {
    const h = harness();
    h.original.result.persistedOutputPath = '/project/tool-results/original.txt';
    if (condition === 'small') h.read.mockResolvedValue('small output');
    if (condition === 'unreadable') h.read.mockRejectedValue(new Error('file unavailable'));
    if (condition === 'scoring fails') {
      h.read.mockResolvedValue(h.original.result.stdout);
      h.fetch.mockRejectedValue(new Error('network unavailable'));
    }
    expect(await h.run()).toBe(h.original);
    expect(h.write).not.toHaveBeenCalled();
    if (condition !== 'scoring fails') {
      expect(h.readMessages).not.toHaveBeenCalled();
      expect(h.fetch).not.toHaveBeenCalled();
    }
  });

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
