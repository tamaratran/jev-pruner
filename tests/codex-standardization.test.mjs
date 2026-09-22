import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, chmod, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { createGate } from '../evals/codex_gate.mjs';
import { fingerprint, initialRequest, workspaceManifest } from '../evals/codex_start.mjs';
import { summarize } from '../evals/codex_bench_audit.mjs';

const request = () => ({
  model: 'gpt-5.5', instructions: 'base instructions',
  reasoning: { effort: 'high' },
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build' }] }],
  tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }],
  prompt_cache_key: 'session-a',
});

test('initial fingerprints preserve all prompt content and settings', () => {
  const original = request();
  const hash = fingerprint(initialRequest(original));
  assert.equal(fingerprint(initialRequest({ ...original, prompt_cache_key: 'session-b' })), hash);
  for (const changed of [
    { ...original, instructions: 'different plugin guidance' },
    { ...original, tools: [{ type: 'function', name: 'other' }] },
    { ...original, input: [...original.input, { type: 'message', role: 'developer', content: 'recommendations' }] },
    { ...original, service_tier: 'priority' },
  ]) assert.notEqual(fingerprint(initialRequest(changed)), hash);
  assert.throws(() => initialRequest({ ...original, previous_response_id: 'old' }), /earlier response/);
  assert.throws(() => initialRequest({ ...original, reasoning: { effort: 'low' } }), /reasoning/);
  assert.throws(() => initialRequest({ ...original, input: [{ type: 'function_call_output' }] }), /fresh conversation/);
});

test('normalization removes only enumerated transport identifiers, preserving other metadata', () => {
  const first = request();
  first.input[0].id = 'msg_a';
  first.input[0].internal_chat_message_metadata_passthrough = {
    turn_id: 'a', create_time: 1, content_item_kinds: ['user.text'],
  };
  first.client_metadata = {
    session_id: 'a',
    'x-codex-turn-metadata': JSON.stringify({ turn_id: 'a', turn_started_at_unix_ms: 1, sandbox_mode: 'none' }),
  };
  const second = structuredClone(first);
  second.input[0].id = 'msg_b';
  second.input[0].internal_chat_message_metadata_passthrough.turn_id = 'b';
  second.input[0].internal_chat_message_metadata_passthrough.create_time = 2;
  second.client_metadata = {
    session_id: 'b',
    'x-codex-turn-metadata': JSON.stringify({ turn_id: 'b', turn_started_at_unix_ms: 2, sandbox_mode: 'none' }),
  };
  assert.equal(fingerprint(initialRequest(first)), fingerprint(initialRequest(second)));
  second.client_metadata.unknown_new_field = 'must compare';
  assert.notEqual(fingerprint(initialRequest(first)), fingerprint(initialRequest(second)));
  assert.equal(first.input[0].id, 'msg_a', 'Do not mutate the forwarded body');
});
test('workspace evidence detects contents, hidden files, modes, links and added files', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-start-test-'));
  try {
    await mkdir(join(root, 'work'));
    await writeFile(join(root, 'work', '.config'), 'original');
    await symlink('work/.config', join(root, 'link'));
    let before = fingerprint(await workspaceManifest(root));
    for (const change of [
      () => writeFile(join(root, 'work', '.config'), 'changed'),
      () => chmod(join(root, 'work', '.config'), 0o700),
      () => writeFile(join(root, 'extra'), 'added'),
    ]) {
      await change();
      const after = fingerprint(await workspaceManifest(root));
      assert.notEqual(after, before);
      before = after;
    }
    await symlink('/etc', join(root, 'outside'));
    await assert.rejects(workspaceManifest(root), /escapes the fingerprinted tree/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const listen = server => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test.each(['matched', 'prompt-drift', 'missing-tools'])(
  'request gate forwards only accepted starts and preserves evidence: %s', async mode => {
    const received = [];
    const records = [];
    let rejects = 0;
    const upstream = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push(JSON.parse(Buffer.concat(chunks)));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"response.completed"}\n\n');
    });
    const upstreamUrl = await listen(upstream);
    const start = { schema: 1, runtime: { package: 'pinned' }, request: initialRequest(request()) };
    const gate = createGate({
      upstream: upstreamUrl, runtime: start.runtime,
      expected: { start, sha256: fingerprint(start) },
      record: async value => records.push(value),
      onReject: () => rejects++,
    });
    const url = await listen(gate);
    try {
      const body = request();
      if (mode === 'prompt-drift') body.instructions += ' extra';
      if (mode === 'missing-tools') delete body.tools;
      const result = await fetch(`${url}/codex/responses`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { authorization: 'Bearer fixture-only', 'content-type': 'application/json' },
      });
      await result.text();
      assert.equal(result.status, mode === 'matched' ? 200 : 409);
      assert.equal(received.length, mode === 'matched' ? 1 : 0);
      assert.equal(rejects, mode === 'matched' ? 0 : 1);
      assert(!JSON.stringify(records).includes('fixture-only'), 'Must not record authorization headers');
      if (mode === 'matched') {
        assert.deepEqual(received[0], body, 'Forward the original request, including cache key');
        const later = { ...body, input: [{ type: 'function_call_output', output: 'different trajectory' }] };
        const next = await fetch(`${url}/codex/responses`, { method: 'POST', body: JSON.stringify(later) });
        assert.equal(next.status, 200);
        await next.text();
        assert.deepEqual(received[1], later);
        assert.equal(records.length, 1);
      }
    } finally { await close(gate); await close(upstream); }
  },
);

test('mismatched and incomplete pairs remain in accounting but never controlled results', () => {
  const rows = ['valid', 'drift', 'incomplete', 'unchanged', 'failed'].flatMap(task =>
    ['control', 'plugin'].map(arm => ({
      task, arm, state: 'finished', measurement_valid: true,
      standardization_required: true, start_valid: task !== 'incomplete', configuration_valid: true,
      start_sha256: task === 'drift' ? arm : 'same',
      reward: task === 'failed' ? 0 : 1, jev_requests: 0, jev_input_tokens: 0,
      pruned_outputs: arm === 'plugin' && task !== 'unchanged' ? 1 : 0,
      archive_recovery_calls: 0, normalized_cost_usd: 1,
    })));
  const result = summarize(rows);
  assert.deepEqual(result.controlled_tasks, ['valid', 'unchanged', 'failed']);
  assert.deepEqual(result.qualifying_tasks, ['valid', 'failed']);
  assert.equal(result.overall.plugin.planned, 5);
  assert.equal(result.overall.plugin.normalized_cost_usd_known, 5);
  assert.equal(result.controlled.plugin.planned, 3);
  assert.equal(result.effectiveness.plugin.failed, 1);
});
