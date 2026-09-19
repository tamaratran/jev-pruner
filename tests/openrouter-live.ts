import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { MatchedHook } from 'claude-code';
import { register } from '../hooks/fast-jev-output.js';
import type { ConversationMessage } from '../src/history.js';
import { classifyOutput } from '../src/output.js';

const apiKey = process.env.OPENROUTER_API_KEY;
assert(apiKey, 'Set OPENROUTER_API_KEY before running this billable test.');

const decisionsUrl = process.env.OPENROUTER_DECISIONS_URL ?? 'https://openrouter.ai/api/alpha/decisions';
const model = process.env.OPENROUTER_JUDGE_MODEL ?? '~typesafe/jev-latest';

type BashHook = MatchedHook<'tool.call', { tool: 'Bash' }>;
type Run = {
  stdout: string;
  stderr?: string;
  command: string;
  messages: ConversationMessage[];
};

function noisyLines(prefix: string): string[] {
  return Array.from(
    { length: 200 },
    (_, index) => `${prefix} ${index}: ${'cached input unchanged '.repeat(55)}`,
  );
}

async function runPruner(input: Run) {
  const on = mock.fn((..._args: unknown[]) => ({ catch() {} }));
  register(on, {
    apiKey,
    baseUrl: decisionsUrl,
    model,
    diagnostics: true,
  });
  const hook = on.mock.calls[0]!.arguments[2] as BashHook;
  const files = new Map<string, string>();
  const diagnostics: string[] = [];
  const requests: { durationMs: number; usage?: unknown; model?: string }[] = [];
  const host = {
    env: { get: async () => undefined },
    settings: { read: async () => ({}) },
    session: { messages: async () => input.messages },
    fs: {
      exists: async (path: string) => files.has(path),
      write: async (path: string, content: string) => { files.set(path, content); },
      read: async (path: string) => files.get(path) ?? '',
    },
    http: {
      fetch: async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const started = Date.now();
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
        const text = await response.text();
        let payload: { usage?: unknown; model?: string } | undefined;
        try { payload = JSON.parse(text) as { usage?: unknown; model?: string }; } catch { /* response error below */ }
        requests.push({ durationMs: Date.now() - started, usage: payload?.usage, model: payload?.model });
        return { status: response.status, ok: response.ok, text };
      },
    },
    ui: { log: (message: string) => diagnostics.push(message), toast: mock.fn() },
  };
  const result = await hook(
    host as unknown as Parameters<BashHook>[0],
    { tool: 'Bash', command: input.command, tool_use_id: 'openrouter-live' },
    async () => ({ result: { stdout: input.stdout, stderr: input.stderr ?? '', interrupted: false } }) as unknown as ReturnType<BashHook>,
  );
  return { result, files, diagnostics, requests };
}

test('OpenRouter Jev prunes noisy build output while retaining diagnostics and an archived original', { timeout: 180_000 }, async () => {
  const artifact = 'Artifact: dist/release-alpha-6d81.tar.gz';
  const failure = 'ERROR: deployment blocked because the release directory is not writable.';
  const lines = noisyLines('build progress');
  lines[65] = artifact;
  lines[125] = failure;
  lines[199] = 'Tests: 204 passed, 0 failed. Build finished.';
  const stdout = lines.join('\n');
  const { result, files, diagnostics, requests } = await runPruner({
    command: 'npm run build',
    stdout,
    stderr: 'warning: non-blocking telemetry upload failed',
    messages: [{ role: 'user', text: 'Keep the release artifact and deployment failure.', toolUses: [] }],
  });

  assert(requests.length > 0, 'Jev was not called for oversized build output');
  assert('result' in result && result.result);
  assert(result.result.stdout.length < stdout.length);
  assert(result.result.stdout.includes(artifact));
  assert(result.result.stdout.includes('Tests: 204 passed, 0 failed. Build finished.'));
  assert.equal(result.result.stderr, 'warning: non-blocking telemetry upload failed');
  const archivePath = '.claude/fast-jev-output/bash-openrouter-live.txt';
  assert.equal(files.get(archivePath), `${stdout}\nwarning: non-blocking telemetry upload failed`);
  assert(result.result.stdout.includes(`[fast-jev-output full output: ${archivePath} (Read or grep it if needed)]`));
  assert(diagnostics.some(message => message.includes('"decision":"pruned"')));
  console.log(JSON.stringify({
    fixture: 'build', before: stdout.length, after: result.result.stdout.length,
    requests, archiveRecovered: files.get(archivePath) === `${stdout}\nwarning: non-blocking telemetry upload failed`,
  }));
});

test('OpenRouter Jev retains task-required log search evidence while dropping repetitive matches', { timeout: 180_000 }, async () => {
  const required = 'logs/runner.log:87: cache miss count 17';
  const lines = noisyLines('logs/runner.log');
  lines[65] = required;
  lines[199] = 'Search complete: 1 relevant source match.';
  const stdout = lines.join('\n');
  assert.equal(classifyOutput('rg -n cache-miss logs', stdout), 'search');
  const { result, requests } = await runPruner({
    command: 'rg -n cache-miss logs',
    stdout,
    messages: [{ role: 'user', text: 'Locate and retain the log line reporting cache misses.', toolUses: [] }],
  });

  assert(requests.length > 0, 'Jev was not called for oversized search output');
  assert('result' in result && result.result);
  assert(result.result.stdout.length < stdout.length);
  assert(result.result.stdout.includes(required));
  assert(result.result.stdout.includes('Search complete: 1 relevant source match.'));
  console.log(JSON.stringify({ fixture: 'search', before: stdout.length, after: result.result.stdout.length, requests }));
});

test('whole-document output bypasses OpenRouter and remains verbatim', async () => {
  const stdout = `export const configuration = { mode: 'strict' };\n${'// generated source context\n'.repeat(12_000)}`;
  const { result, requests } = await runPruner({
    command: 'cat src/config.ts',
    stdout,
    messages: [{ role: 'user', text: 'Read the configuration source.', toolUses: [] }],
  });

  assert.equal(requests.length, 0);
  assert('result' in result && result.result);
  assert.equal(result.result.stdout, stdout);
  console.log(JSON.stringify({ fixture: 'document-bypass', before: stdout.length, after: result.result.stdout.length, requests }));
});
