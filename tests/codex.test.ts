import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { codexMessages } from '../src/codex/history.js';
import { contextPath, readTranscript, saveContext } from '../src/codex/context.js';
import { pruneCodexOutput } from '../src/codex/prune.js';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';

const directories: string[] = [];
const sessionId = 'codex-test';
const transcript = [
  { type: 'session_meta', payload: { id: sessionId } },
  { type: 'event_msg', payload: { type: 'user_message', message: 'duplicate prompt' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'Keep the artifact from the previous result.' },
  ] } },
  { type: 'response_item', payload: {
    type: 'function_call', call_id: 'call-1', name: 'exec_command',
    arguments: '{"cmd":"printf artifact=release.tar"}',
  } },
  { type: 'response_item', payload: {
    type: 'function_call_output', call_id: 'call-1', output: 'artifact=release.tar',
  } },
  { type: 'response_item', payload: {
    type: 'custom_tool_call', call_id: 'call-2', name: 'apply_patch', input: 'full patch',
  } },
  { type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id: 'call-2',
    output: [{ type: 'input_text', text: 'patch applied' }],
  } },
].map(entry => JSON.stringify(entry)).join('\n');
const output = Buffer.from(`${'cache '.repeat(35)}\n`.repeat(400));
const discard = vi.fn(async (_state: JevState, questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
}));

async function fixture() {
  const cwd = await mkdtemp(join(homedir(), 'jev-codex-test-'));
  directories.push(cwd);
  const path = join(cwd, 'rollout.jsonl');
  await writeFile(path, transcript);
  await saveContext({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    session_id: sessionId, transcript_path: path,
  }, cwd);
  return { cwd, home: cwd, sessionId, apiKey: 'synthetic', asker: { ask: discard } };
}

afterEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Codex transcript adapter', () => {
  it('preserves complete tool arguments and string/structured results without event duplicates', () => {
    expect(codexMessages(transcript, sessionId)).toEqual([
      { role: 'user', text: 'Keep the artifact from the previous result.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{
        tool_use_id: 'call-1', tool: 'exec_command',
        input: { arguments: '{"cmd":"printf artifact=release.tar"}' },
      }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{
        tool_use_id: 'call-1', text: 'artifact=release.tar', result: undefined,
      }] },
      { role: 'assistant', text: '', toolUses: [{
        tool_use_id: 'call-2', tool: 'apply_patch', input: { input: 'full patch' },
      }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{
        tool_use_id: 'call-2', text: '',
        result: [{ type: 'input_text', text: 'patch applied' }],
      }] },
    ]);
  });

  it('refuses incomplete or wrong-session transcripts', () => {
    expect(() => codexMessages(`${transcript}\n{"type":`, sessionId)).toThrow();
    expect(() => codexMessages(transcript, 'another-session')).toThrow();
    expect(() => contextPath('../escape')).toThrow();
  });

  it('round-trips the host transcript pointer and invalidates unavailable history', async () => {
    const options = await fixture();
    expect(await readTranscript(sessionId, options.home)).toBe(transcript);
    await saveContext({
      hook_event_name: 'PreToolUse', tool_name: 'Bash',
      session_id: sessionId, transcript_path: null,
    }, options.home);
    await expect(readTranscript(sessionId, options.home)).rejects.toThrow();
  });
});

describe('Codex output pruning', () => {
  it.each([9_999, 10_000])('passes through %i tokens without archives or scoring', async tokens => {
    const options = await fixture();
    const small = Buffer.from('cache\n'.repeat(tokens));
    expect(estimateTokens(small.toString())).toBe(tokens);
    expect(await pruneCodexOutput(small, 'npm test', options)).toBe(small);
    expect(discard).not.toHaveBeenCalled();
    await expect(readdir(join(options.cwd, '.jev-pruner'))).rejects.toThrow();
  });

  it('archives exact stdout before scoring and supplies complete current-run history', async () => {
    const options = await fixture();
    const ask = vi.fn(async (state: JevState, questions: JevQuestions) => {
      const files = await readdir(join(options.cwd, '.jev-pruner'));
      const archive = files.find(file => file.endsWith('.txt'))!;
      expect(await readFile(join(options.cwd, '.jev-pruner', archive))).toEqual(output);
      const serialized = JSON.stringify(state);
      expect(serialized).toContain('artifact=release.tar');
      expect(serialized).toContain('full patch');
      expect(serialized).toContain('patch applied');
      expect(serialized).toContain('categoryGuidance');
      return discard(state, questions);
    });
    const pruned = await pruneCodexOutput(output, 'npm test', { ...options, asker: { ask } });
    expect(ask).toHaveBeenCalled();
    expect(pruned.length).toBeLessThan(output.length);
    expect(pruned.toString()).toContain('[fast-jev-output full output:');
    expect(pruned.subarray(0, 100)).toEqual(output.subarray(0, 100));
  });

  it('preserves original output on archive or Jev failures', async () => {
    const options = await fixture();
    const ask = vi.fn(async () => { throw new Error('unavailable'); });
    expect(await pruneCodexOutput(output, 'npm test', {
      ...options, asker: { ask },
    })).toBe(output);
    expect(ask).toHaveBeenCalled();
    await rm(join(options.cwd, '.jev-pruner'), { recursive: true });
    await writeFile(join(options.cwd, '.jev-pruner'), 'occupied');
    discard.mockClear();
    expect(await pruneCodexOutput(output, 'npm test', options)).toBe(output);
    expect(discard).not.toHaveBeenCalled();
  });

  it('prunes progress around a failed test source excerpt and archives exact stdout', async () => {
    const options = await fixture();
    const section = [
      '=== FAILURES ===',
      '    def test_capture():',
      ...Array.from({ length: 50 }, (_, index) => `        value_${index} = capture(${index})`),
      '>       assert captured == "expected"',
      "E       AssertionError: assert 'actual' == 'expected'",
      'tests/test_capture.py:54: AssertionError',
      '=== 1 failed, 399 passed in 1.0s ===',
    ].join('\n');
    const original = Buffer.from(`${output.toString()}\n${section}\n${output.toString()}`);
    const pruned = await pruneCodexOutput(original, 'node diagnostic-collector.mjs', { ...options, exitCode: 1 });
    expect(discard).toHaveBeenCalled();
    expect(discard.mock.calls.every(([state]) => (state as { exitCode: number }).exitCode === 1)).toBe(true);
    expect(pruned.length).toBeLessThan(original.length);
    expect(pruned.toString()).toContain(section);
    const archives = (await readdir(join(options.cwd, '.jev-pruner'))).filter(file => file.endsWith('.txt'));
    expect(archives).toHaveLength(1);
    expect(await readFile(join(options.cwd, '.jev-pruner', archives[0]!))).toEqual(original);
    expect(pruned.toString()).toContain(`[fast-jev-output full output: ${join(options.cwd, '.jev-pruner', archives[0]!)}`);
  });

  it('fails open for missing state, absent keys, structured output and secret-like content', async () => {
    const options = await fixture();
    for (const extra of [{ sessionId: undefined }, { apiKey: undefined }, { home: '/unavailable' }]) {
      expect(await pruneCodexOutput(output, 'npm test', { ...options, ...extra })).toBe(output);
    }
    for (const command of ['cat document.txt', 'printenv']) {
      expect(await pruneCodexOutput(output, command, options)).toBe(output);
    }
    const secret = Buffer.concat([output, Buffer.from('\napi_key=synthetic-example')]);
    expect(await pruneCodexOutput(secret, 'npm test', options)).toBe(secret);
    const binary = Buffer.concat([output, Buffer.from([0xff])]);
    expect(await pruneCodexOutput(binary, 'npm test', options)).toBe(binary);
    expect(discard).not.toHaveBeenCalled();
  });

  it('aborts in-flight scoring and returns the original output on cancellation', async () => {
    const options = await fixture();
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    }));
    vi.stubGlobal('fetch', fetch);
    expect(await pruneCodexOutput(output, 'npm test', {
      ...options, asker: undefined, signal: controller.signal,
    })).toBe(output);
    expect(fetch).toHaveBeenCalled();
    expect(fetch.mock.calls.every(([, init]) => init.signal!.aborted)).toBe(true);
  });
});

async function run(parameters: string[]) {
  const child = spawn(process.execPath, [
    '--import', 'tsx', resolve('src/codex/run.ts'), '--', ...parameters,
  ], { env: { ...process.env, CODEX_THREAD_ID: '', TYPESAFE_API_KEY: '' } });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end();
  return new Promise<{ stdout: Buffer; stderr: string; code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({
        stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString(), code, signal,
      }));
    },
  );
}

describe('Codex command wrapper', () => {
  it.each([
    { code: 0, mode: 'pruned' },
    { code: 7, mode: 'pruned' },
    { code: 23, mode: 'scoring failure' },
    { code: 7, mode: 'archive failure' },
    { code: 7, mode: 'reference' },
  ])('preserves exit $code and stderr with $mode', async ({ code, mode }) => {
    const options = await fixture();
    const facts = [
      'warning: dependency version differs',
      'src/example.ts:4:2: error TS2322: Type string is not assignable to number.',
      'Tests: 1 failed, 399 passed',
      'Artifact path: dist/diagnostics.txt',
      'The deployment region must remain eu-west-1.',
    ];
    if (mode === 'reference') facts.push(
      '# Build instructions',
      'export const region = "eu-west-1";',
      '00000010: 48 89 c3 mov %rax,%rbx',
    );
    const original = Buffer.from(`${output.toString()}${facts.join('\n')}\n${output.toString()}`);
    const input = join(options.cwd, 'stdout.txt');
    const calls = join(options.cwd, 'states.jsonl');
    const transport = join(options.cwd, 'fetch.mjs');
    await writeFile(input, original);
    if (mode === 'archive failure') await writeFile(join(options.cwd, '.jev-pruner'), 'occupied');
    await writeFile(transport, `
      import { appendFileSync } from 'node:fs';
      globalThis.fetch = async (_url, init) => {
        const { state, questions } = JSON.parse(init.body);
        appendFileSync(${JSON.stringify(calls)}, JSON.stringify(state) + '\\n');
        if (${JSON.stringify(mode)} === 'scoring failure') {
          return new Response('unavailable', { status: 503 });
        }
        return new Response(JSON.stringify({
          answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
        }));
      };
    `);
    const child = spawn(process.execPath, [
      '--import', createRequire(import.meta.url).resolve('tsx'),
      '--import', transport, resolve('src/codex/run.ts'), '--',
      process.execPath, '-e', `
        process.stdout.write(require('node:fs').readFileSync(process.argv[1]));
        process.stderr.write(Buffer.from([0, 255, 10]));
        process.exitCode = ${code};
      `, input,
    ], {
      cwd: options.cwd,
      env: { ...process.env, HOME: options.home, CODEX_THREAD_ID: sessionId, TYPESAFE_API_KEY: 'synthetic' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end();
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    expect(result).toEqual({ code, signal: null });
    expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 255, 10]));
    const displayed = Buffer.concat(stdout);
    if (mode === 'archive failure' || mode === 'reference') {
      await expect(readFile(calls)).rejects.toThrow();
      if (mode === 'reference') await expect(readdir(join(options.cwd, '.jev-pruner'))).rejects.toThrow();
    } else {
      const states: { exitCode: number }[] = (await readFile(calls, 'utf8'))
        .trim().split('\n').map(line => JSON.parse(line));
      expect(states.length).toBeGreaterThan(0);
      expect(states.every(state => state.exitCode === code)).toBe(true);
      const archives = (await readdir(join(options.cwd, '.jev-pruner'))).filter(file => file.endsWith('.txt'));
      expect(archives).toHaveLength(1);
      expect(await readFile(join(options.cwd, '.jev-pruner', archives[0]!))).toEqual(original);
      if (mode === 'pruned') {
        expect(displayed.length).toBeLessThan(original.length);
        expect(displayed.toString()).toContain('[fast-jev-output trimmed');
        expect(displayed.toString()).toContain(`[fast-jev-output full output: ${join(options.cwd, '.jev-pruner', archives[0]!)}`);
        for (const fact of facts) expect(displayed.toString().split('\n')).toContain(fact);
      }
    }
    if (mode !== 'pruned') expect(displayed).toEqual(original);
  });

  it('preserves literal arguments, binary stdout, stderr, and failure status', async () => {
    const argument = 'space $HOME "quote"; $(echo must-not-run)';
    const result = await run([process.execPath, '-e', `
      process.stdout.write(Buffer.from([0, 255]));
      process.stdout.write(process.argv[1]);
      process.stderr.write('diagnostic\\n');
      process.exitCode = 7;
    `, argument]);
    expect(result).toEqual({
      stdout: Buffer.concat([Buffer.from([0, 255]), Buffer.from(argument)]),
      stderr: 'diagnostic\n', code: 7, signal: null,
    });
  });

  it('streams output exceeding the capture limit without dropping bytes', async () => {
    const result = await run([process.execPath, '-e', 'process.stdout.write("x".repeat(9 * 1024 * 1024))']);
    expect(result.code).toBe(0);
    expect(result.stdout.equals(Buffer.alloc(9 * 1024 * 1024, 'x'))).toBe(true);
  });

  it('propagates a child signal and handles missing executables', async () => {
    const signaled = await run([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")']);
    expect(signaled.signal).toBe('SIGTERM');
    const missing = await run(['jev-pruner-command-that-does-not-exist']);
    expect(missing.code).toBe(127);
    expect(missing.stderr).toContain('unable to start command');
  });

  it('flushes buffered output before propagating a terminating signal', async () => {
    const result = await run([process.execPath, '-e', `
      process.stdout.write('x'.repeat(512 * 1024), () => process.kill(process.pid, 'SIGTERM'));
    `]);
    expect(result.signal).toBe('SIGTERM');
    expect(result.stdout.equals(Buffer.alloc(512 * 1024, 'x'))).toBe(true);
  });

  it.each([
    ['SIGINT', 0], ['SIGTERM', 0], ['SIGINT', 7], ['SIGTERM', 7],
  ] as const)('propagates %s when cancelled after exit %i', async (termination, code) => {
    const options = await fixture();
    const transport = join(options.cwd, 'waiting-fetch.mjs');
    await writeFile(transport, `
      globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        process.stderr.write('waiting-for-jev\\n');
      });
    `);
    const child = spawn(process.execPath, [
      '--import', 'tsx', '--import', transport, resolve('src/codex/run.ts'), '--',
      process.execPath, '-e', `process.stdout.write(("cache ".repeat(35) + "\\n").repeat(400)); process.exitCode = ${code}`,
    ], {
      env: {
        ...process.env, HOME: options.home,
        CODEX_THREAD_ID: sessionId, TYPESAFE_API_KEY: 'synthetic',
      },
    });
    const buffers: Buffer[] = [];
    let cancelled = false;
    child.stdout.on('data', (chunk: Buffer) => buffers.push(chunk));
    child.stderr.on('data', () => {
      if (!cancelled) {
        cancelled = true;
        child.kill(termination);
      }
    });
    child.stdin.end();
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    expect(cancelled).toBe(true);
    expect(result).toEqual({ code: null, signal: termination });
    expect(Buffer.concat(buffers)).toEqual(output);
  });
});
