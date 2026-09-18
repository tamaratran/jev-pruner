import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
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
});
