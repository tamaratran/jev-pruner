import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { contextPath, saveContext } from '../src/codex/context.js';
import { codexMessages } from '../src/codex/history.js';
import { pruneCodexOutput } from '../src/codex/prune.js';
import { estimateTokens } from '../src/jev.js';
import type { JevQuestions, JevState } from '../src/jev.js';

const directories: string[] = [];
const sessionId = 'boundary-test';
const output = Buffer.from(('cache '.repeat(35) + '\n').repeat(400));
const transcript = [
  { type: 'session_meta', payload: { id: sessionId } },
  { type: 'response_item', payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep deployment artifacts.' }],
  } },
].map(entry => JSON.stringify(entry)).join('\n');

async function fixture() {
  const cwd = await mkdtemp(join(homedir(), 'jev-codex-boundary-'));
  directories.push(cwd);
  const path = join(cwd, 'rollout.jsonl');
  await writeFile(path, transcript);
  await saveContext({
    hook_event_name: 'PreToolUse', tool_name: 'Bash',
    session_id: sessionId, transcript_path: path,
  }, cwd);
  return { cwd, home: cwd, path, sessionId, apiKey: 'synthetic' };
}

const discard = vi.fn(async (_state: JevState, questions: JevQuestions) => ({
  answers: Object.fromEntries(Object.keys(questions).map(id => [id, { noul: 0 }])),
}));

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Codex adapter boundaries', () => {
  it.each([
    ['unauthorized', 401, '{"error":"unauthorized"}'],
    ['rate limit', 429, '{"error":"rate limit"}'],
    ['server error', 503, '{"error":"unavailable"}'],
    ['invalid JSON', 200, '{'],
    ['missing answers', 200, '{}'],
    ['missing scores', 200, '{"answers":{}}'],
  ])('preserves exact stdout on %s', async (_name, status, body) => {
    const options = await fixture();
    const fetch = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', fetch);
    expect(await pruneCodexOutput(output, 'npm test', options)).toBe(output);
    expect(fetch).toHaveBeenCalled();
    const files = (await readdir(join(options.cwd, '.jev-pruner'))).filter(file => file.endsWith('.txt'));
    expect(files).toHaveLength(1);
    expect(await readFile(join(options.cwd, '.jev-pruner', files[0]!))).toEqual(output);
  });

  it('enforces the request deadline without losing original output', async () => {
    const options = await fixture();
    vi.useFakeTimers();
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signals.push(init.signal!);
      init.signal!.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
      started();
    })));
    const pending = pruneCodexOutput(output, 'npm test', options);
    await ready;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(output);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['JSON', Buffer.from(JSON.stringify({ rows: Array(12_000).fill('cache') }))],
    ['XML', Buffer.from(`<root>${'<row>cache</row>'.repeat(12_000)}</root>`)],
    ['YAML', Buffer.from('---\nrows:\n' + '  - cache\n'.repeat(12_000))],
    ['diff', Buffer.from('diff --git a/a b/a\n--- a/a\n+++ b/a\n' + '+cache\n'.repeat(12_000))],
    ['NUL', Buffer.concat([output, Buffer.from([0])])],
    ['invalid UTF-8', Buffer.concat([output, Buffer.from([0xc3, 0x28])])],
  ])('does not score or archive %s', async (_name, document) => {
    const options = await fixture();
    expect(estimateTokens(document.toString())).toBeGreaterThan(10_000);
    expect((await pruneCodexOutput(document, 'node producer.js', {
      ...options, asker: { ask: discard },
    })) === document).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    await expect(readdir(join(options.cwd, '.jev-pruner'))).rejects.toThrow();
  });

  it.each(['malformed', 'wrong session', 'missing file'])('fails open with %s history', async mode => {
    const options = await fixture();
    if (mode === 'missing file') await rm(options.path);
    else await writeFile(options.path, mode === 'malformed' ? transcript + '\n{' : transcript.replace(sessionId, 'other'));
    expect(await pruneCodexOutput(output, 'npm test', {
      ...options, asker: { ask: discard },
    })).toBe(output);
    expect(discard).not.toHaveBeenCalled();
  });

  it('protects metadata and archives and crosses the strict token threshold', async () => {
    const options = await fixture();
    const above = Buffer.from('cache\n'.repeat(10_001));
    expect(estimateTokens(above.toString())).toBe(10_001);
    const pruned = await pruneCodexOutput(above, 'npm test', { ...options, asker: { ask: discard } });
    expect(discard).toHaveBeenCalled();
    expect(pruned.length).toBeLessThan(above.length);
    const directory = join(options.cwd, '.jev-pruner');
    const archive = (await readdir(directory)).find(file => file.endsWith('.txt'))!;
    expect(await readFile(join(directory, archive))).toEqual(above);
    for (const file of [join(directory, archive), contextPath(sessionId, options.home)]) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('does not include reasoning or privileged prompts', () => {
    const extra = [
      { type: 'reasoning', summary: [{ text: 'REASONING_ONLY' }] },
      { type: 'message', role: 'system', content: [{ text: 'SYSTEM_ONLY' }] },
      { type: 'message', role: 'developer', content: [{ text: 'DEVELOPER_ONLY' }] },
    ].map(payload => JSON.stringify({ type: 'response_item', payload })).join('\n');
    const serialized = JSON.stringify(codexMessages(transcript + '\n' + extra, sessionId));
    expect(serialized).not.toMatch(/REASONING_ONLY|SYSTEM_ONLY|DEVELOPER_ONLY/);
  });
});

async function command(script: string, input = '') {
  const options = await fixture();
  const child = spawn(process.execPath, [
    '--import', createRequire(import.meta.url).resolve('tsx'), resolve('src/codex/run.ts'), '--', process.execPath, '-e', script,
  ], {
    cwd: options.cwd,
    env: { ...process.env, CODEX_THREAD_ID: '', TYPESAFE_API_KEY: '', JEV_TEST_VALUE: 'preserved' },
  });
  const buffers: Buffer[] = [];
  const errors: Buffer[] = [];
  child.stdout.on('data', (data: Buffer) => buffers.push(data));
  child.stderr.on('data', (data: Buffer) => errors.push(data));
  child.stdin.end(input);
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { ...result, stdout: Buffer.concat(buffers), stderr: Buffer.concat(errors), cwd: options.cwd };
}

describe('Codex subprocess boundaries', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('forwards %s to a running child and flushes stdout', async termination => {
    const child = spawn(process.execPath, [
      '--import', 'tsx', resolve('src/codex/run.ts'), '--', process.execPath, '-e', `
        process.stdout.write('before-cancellation\\n', () => process.stderr.write('child-ready'));
        setInterval(() => {}, 1000);
      `,
    ], { env: { ...process.env, CODEX_THREAD_ID: '', TYPESAFE_API_KEY: '' } });
    const buffers: Buffer[] = [];
    let cancelled = false;
    child.stdout.on('data', (data: Buffer) => buffers.push(data));
    child.stderr.on('data', (data: Buffer) => {
      if (data.toString().includes('child-ready') && !cancelled) {
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
    expect(Buffer.concat(buffers).toString()).toBe('before-cancellation\n');
  });

  it('preserves stdin, cwd, environment, and separate stderr', async () => {
    const result = await command(`
      process.stdin.pipe(process.stdout);
      process.stdout.write(process.cwd() + '\\n' + process.env.JEV_TEST_VALUE + '\\n');
      process.stderr.write('stderr-only');
    `, 'stdin-only\n');
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe(`${result.cwd}\npreserved\nstdin-only\n`);
    expect(result.stderr.toString()).toBe('stderr-only');
  });

  it.each([8 * 1024 * 1024 - 1, 8 * 1024 * 1024, 8 * 1024 * 1024 + 1])(
    'preserves all %i bytes at the capture boundary', async bytes => {
      const result = await command(`process.stdout.write(Buffer.alloc(${bytes}, 0x61))`);
      expect(result.code).toBe(0);
      expect(result.stdout.equals(Buffer.alloc(bytes, 0x61))).toBe(true);
    },
  );

  it('preserves SIGINT and complete stdout from the child', async () => {
    const result = await command(`
      process.stdout.write('completed\\n', () => process.kill(process.pid, 'SIGINT'));
    `);
    expect(result.signal).toBe('SIGINT');
    expect(result.stdout.toString()).toBe('completed\n');
  });
});
