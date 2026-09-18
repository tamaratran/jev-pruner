import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { TestContext } from 'node:test';
import type { MatchedHook } from 'claude-code';
import { jevAsker, register } from '../hooks/fast-jev-output.js';
import type { HookFetch } from '../hooks/fast-jev-output.js';
import type { ConversationMessage } from '../src/history.js';
import { estimateStateTokens } from '../src/jev.js';
import type { JevAsker, JevQuestions, JevState } from '../src/jev.js';
import { trimOutput } from '../src/output.js';

const apiKey = process.env.TYPESAFE_API_KEY;
assert(apiKey, 'Set TYPESAFE_API_KEY before running the live Jev tests.');

function liveAsker(t: TestContext) {
  const requests: { state: JevState; questions: JevQuestions }[] = [];
  const client = jevAsker(async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    return { status: response.status, ok: response.ok, text: await response.text() };
  }, apiKey!, 'jev-latest');
  const asker: JevAsker = {
    async ask(state, questions) {
      requests.push({ state, questions });
      const start = Date.now();
      const response = await client.ask(state, questions);
      t.diagnostic(JSON.stringify({
        model: response.model,
        questions: Object.keys(questions).length,
        estimatedStateTokens: estimateStateTokens(JSON.stringify(state)),
        usage: response.usage,
        durationMs: Date.now() - start,
      }));
      return response;
    },
  };
  return { asker, requests };
}

function transcript(): ConversationMessage[] {
  return [
    { role: 'user', text: 'Preserve the alpha artifact filename for the deployment.', toolUses: [] },
    {
      role: 'assistant',
      text: 'The deployment needs the alpha artifact filename from the build output.',
      toolUses: [{
        tool_use_id: 'read-manifest',
        tool: 'Read',
        input: { file_path: 'manifest.txt' },
        text: 'OMITTED_TOOL_RESULT_SENTINEL',
        result: { content: 'OMITTED_STRUCTURED_RESULT_SENTINEL' },
      }],
    },
    {
      role: 'user',
      text: '',
      toolUses: [],
      toolResults: [{
        tool_use_id: 'read-manifest',
        text: 'OMITTED_TOOL_RESULT_SENTINEL',
        result: { content: 'OMITTED_STRUCTURED_RESULT_SENTINEL' },
      }],
    },
    ...['Continue.', 'Run checks.', 'Run the build.'].map((text) => ({
      role: 'user' as const,
      text,
      toolUses: [],
    })),
  ];
}

test('live Jev preserves earlier task requirements and errors while pruning noise', { timeout: 180_000 }, async (t) => {
  const { asker, requests } = liveAsker(t);
  const lines = Array.from(
    { length: 200 },
    (_, i) => `progress: cache entry ${i} already up to date; no changes needed`,
  );
  const artifact = 'alpha artifact filename: release-alpha-6d81.tar.gz';
  const error = 'ERROR: deployment blocked because the release directory is not writable.';
  lines[65] = artifact;
  lines[125] = error;
  lines[199] = 'Build finished; deployment remains blocked.';
  const output = lines.join('\n');
  const result = await trimOutput(
    {
      command: 'npm run build',
      goal: 'Continue.\nRun checks.\nRun the build.',
      messages: transcript(),
      output,
    },
    asker,
  );
  assert(requests.length > 0);
  for (const { state } of requests) {
    const serialized = JSON.stringify(state);
    assert(serialized.includes('Preserve the alpha artifact filename'));
    assert(serialized.includes('The deployment needs the alpha artifact'));
    assert(serialized.includes('manifest.txt'));
    assert(!serialized.includes('OMITTED_TOOL_RESULT_SENTINEL'));
    assert(!serialized.includes('OMITTED_STRUCTURED_RESULT_SENTINEL'));
  }
  assert(result.trimmed, 'Jev did not prune any repetitive progress chunks');
  assert(result.output.includes(artifact), 'Jev removed the artifact required by earlier history');
  assert(result.output.includes(error));
  assert(result.output.includes(lines[0]!));
  assert(result.output.includes(lines[199]!));
  assert(result.charsAfter < result.charsBefore);
  assert(result.scores.every((score) => score >= 0 && score <= 1));
  t.diagnostic(JSON.stringify({
    kept: result.kept,
    chunks: result.chunks,
    charsBefore: result.charsBefore,
    charsAfter: result.charsAfter,
    scores: result.scores,
  }));
});

test('live Jev accepts repeated history across multiple question batches', { timeout: 180_000 }, async (t) => {
  const { asker, requests } = liveAsker(t);
  const output = Array.from(
    { length: 200 },
    (_, i) => `progress record ${i}: ${'unchanged cached module '.repeat(12)}`,
  ).join('\n');
  const result = await trimOutput(
    { command: 'build', goal: 'Run the build.', messages: transcript(), output },
    asker,
    { chunkLines: 1 },
  );
  assert(requests.length > 1, 'Fixture did not exercise question batching');
  const state = JSON.stringify(requests[0]!.state);
  for (const request of requests) {
    assert.equal(JSON.stringify(request.state), state);
    assert(estimateStateTokens(JSON.stringify(request.state)) <= 25_000);
  }
  const ids = requests.flatMap(({ questions }) => Object.keys(questions));
  assert.equal(new Set(ids).size, 200);
  assert.equal(ids.length, 200);
  assert(result.trimmed);
});

test('live Jev accepts digit-heavy output with a fitted conversation', { timeout: 180_000 }, async (t) => {
  const { asker, requests } = liveAsker(t);
  const messages: ConversationMessage[] = [
    { role: 'user', text: 'Keep the final build outcome.', toolUses: [] },
    ...Array.from({ length: 100 }, (_, i) => ({
      role: 'assistant' as const,
      text: `Step ${i}: ${'Checked cached build inputs. '.repeat(60)}`,
      toolUses: [],
    })),
    { role: 'user', text: 'Run the build.', toolUses: [] },
  ];
  const output = Array.from(
    { length: 8_000 },
    (_, i) => `1234567890 cache entry ${i} unchanged`,
  ).join('\n');
  const result = await trimOutput(
    { command: 'build', goal: 'Run the build.', messages, output },
    asker,
    { maxStateTokens: 12_000 },
  );
  assert(requests.length > 0, 'State fitting skipped live scoring');
  for (const { state } of requests) {
    assert(estimateStateTokens(JSON.stringify(state)) <= 12_000);
    assert(JSON.stringify(state).includes('Keep the final build outcome.'));
  }
  assert.equal(result.chunks, 200);
  assert(result.output.includes('cache entry 0 unchanged'));
  assert(result.output.includes('cache entry 7999 unchanged'));
});

test('the Bash hook fails open when live Jev rejects authentication', { timeout: 120_000 }, async (t) => {
  type BashHook = MatchedHook<'tool.call', { tool: 'Bash' }>;
  const on = mock.fn((..._args: unknown[]) => ({ catch() {} }));
  register(on, { apiKey: 'invalid-live-test-key' });
  const hook = on.mock.calls[0]!.arguments[2] as BashHook;
  const statuses: number[] = [];
  const logs: string[] = [];
  const writes = mock.fn();
  const fetchLive: HookFetch = async (url, init) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(90_000) });
    statuses.push(response.status);
    return { status: response.status, ok: response.ok, text: await response.text() };
  };
  const host = {
    session: { messages: async () => transcript() },
    http: { fetch: fetchLive },
    fs: { exists: async () => false, write: writes },
    ui: { log: (message: string) => logs.push(message), toast: mock.fn() },
  };
  const original = {
    result: {
      stdout: 'progress: checking an unchanged build dependency\n'.repeat(200),
      stderr: 'stderr must remain intact',
      interrupted: false,
    },
  };
  const next = async () => original;
  const result = await hook(
    host as unknown as Parameters<BashHook>[0],
    { tool: 'Bash', command: 'build', tool_use_id: 'live-auth-rejection' },
    next as unknown as Parameters<BashHook>[2],
  );
  assert.equal(statuses.length, 1);
  assert([401, 403].includes(statuses[0]!));
  assert.equal(result, original);
  assert.equal(writes.mock.calls.length, 0);
  assert(logs.some((message) => message.startsWith('bash output trim skipped')));
  t.diagnostic(`Authentication rejected with HTTP ${statuses[0]}; original result preserved.`);
});
