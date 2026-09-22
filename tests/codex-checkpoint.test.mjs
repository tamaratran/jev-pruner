import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'vitest';
import { checkpointRequest, commonCheckpointHash, createContinuationGate, createRewriter, nativeOutput } from '../evals/codex_checkpoint.mjs';
import { hostPreviews } from '../evals/codex-preview.mjs';

const fresh = () => ({
  model: 'gpt-5.5', instructions: 'identical instructions', reasoning: { effort: 'high' },
  tools: [{ type: 'function', name: 'exec_command' }],
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build task' }] }],
});
const checkpoint = () => {
  const request = fresh();
  request.input.push(
    { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"tar -tzf source"}', call_id: 'a' },
    { type: 'function_call_output', call_id: 'a', output: 'modified list' },
  );
  return { request, target: 2, outputs: { native: 'original list', pruned: 'modified list' } };
};

test('native reconstruction replaces the full preview including its line-count header exactly once', () => {
  const raw = 'original path\n'.repeat(30);
  const delivered = 'kept path\n'.repeat(15);
  const frame = text => `Chunk ID: fixture\nOriginal token count: ${Math.ceil(Buffer.byteLength(text) / 4)}\nOutput:\nWarning: truncated output (original token count: ${Math.ceil(Buffer.byteLength(text) / 4)})\n`;
  const visible = frame(delivered) + hostPreviews(delivered, 10).at(-1);
  const native = nativeOutput(visible, raw, delivered, 10);
  assert.equal(native, frame(raw) + hostPreviews(raw, 10).at(-1));
  assert.equal(native.match(/Total output lines:/g).length, 1);
  assert(native.includes('Total output lines: 30'));
  assert(!native.includes('Total output lines: 15'));
  assert.throws(() => nativeOutput('unmatched', raw, delivered, 10), /does not match/);
});

test('checkpoint branches differ only in the selected output and preserve subsequent history', () => {
  const original = checkpoint();
  const suffix = [{ type: 'function_call', name: 'exec_command', arguments: '{"cmd":"make"}', call_id: 'b' }];
  assert.equal(commonCheckpointHash(original, 'native'), commonCheckpointHash(original, 'pruned'));
  assert.equal(checkpointRequest(original, 'native', suffix).input[2].output, 'original list');
  assert.deepEqual(checkpointRequest(original, 'pruned', suffix).input.slice(3), suffix);
  assert.equal(original.request.input[2].output, 'modified list');
  assert.throws(() => checkpointRequest(original, 'unknown'), /Unknown/);
});

test('rewriter rejects a changed model, tools, reasoning, prompt, or stateful continuation', () => {
  for (const change of [
    { model: 'other' }, { tools: [] }, { reasoning: { effort: 'low' } },
    { instructions: 'different' }, { previous_response_id: 'old' },
  ]) assert.throws(() => createRewriter(checkpoint())({ ...fresh(), ...change }));
});

test('rewriter rejects history replacement and compaction after accepting a fresh runtime', () => {
  const rewrite = createRewriter(checkpoint());
  const first = fresh();
  assert.deepEqual(rewrite(first), []);
  const next = structuredClone(first);
  const suffix = [{ type: 'function_call_output', call_id: 'x', output: 'compiler error' }];
  next.input.push(...suffix);
  assert.deepEqual(rewrite(next), suffix);
  next.input[0].content[0].text = 'summarized';
  assert.throws(() => rewrite(next), /history changed/);
});

const listen = server => new Promise(resolve =>
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });

test('gate forwards only the substituted checkpoint, retains suffix, and stops before a capped request', async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks)));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: {"type":"response.completed","response":{"usage":{"input_tokens":42}}}\n\n');
  });
  const records = [];
  let stopped = false;
  const gate = createContinuationGate({
    checkpoint: checkpoint(), condition: 'native', upstream: await listen(upstream),
    record: async row => { records.push(row); }, stop: () => { stopped = true; },
    maxRequests: 2, delayMs: 5,
  });
  const url = await listen(gate);
  try {
    const first = fresh();
    const suffix = [{ type: 'function_call_output', call_id: 'b', output: 'later unchanged output' }];
    for (const body of [first, { ...first, input: [...first.input, ...suffix] }]) {
      const response = await fetch(`${url}/codex/responses`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /input_tokens/);
    }
    assert.deepEqual(received[0], checkpointRequest(checkpoint(), 'native'));
    assert.deepEqual(received[1], checkpointRequest(checkpoint(), 'native', suffix));
    assert.equal(records.filter(row => row.type === 'forward')[0].requested_delay_ms, 5);
    const capped = await fetch(`${url}/codex/responses`, { method: 'POST', body: JSON.stringify(first) });
    assert.equal(capped.status, 409);
    assert.equal(received.length, 2);
    assert(stopped);
    assert(records.some(row => row.type === 'response' && row.status === 200));
  } finally { await close(gate); await close(upstream); }
});

test('offline probe never reaches inference and mismatched starts are rejected', async () => {
  for (const mismatch of [false, true]) {
    const records = [];
    const gate = createContinuationGate({
      checkpoint: checkpoint(), condition: 'pruned', upstream: 'http://127.0.0.1:1',
      record: async row => { records.push(row); }, stop: () => {}, maxRequests: 2, probe: true,
    });
    try {
      const url = await listen(gate);
      const body = fresh();
      if (mismatch) body.instructions = 'different';
      const response = await fetch(`${url}/codex/responses`, { method: 'POST', body: JSON.stringify(body) });
      assert.equal(response.status, 409);
      assert.equal(records.some(row => row.type === 'probe_accepted'), !mismatch);
      assert.equal(records.some(row => row.type === 'rejected'), mismatch);
      assert(!records.some(row => row.type === 'forward'));
    } finally { await close(gate); }
  }
});

test('gate retains completed SSE accounting when the client closes before HTTP EOF', async () => {
  const event = 'data: {"type":"response.completed","response":{"usage":{"input_tokens":42}}}\n\n';
  const upstream = createServer((_, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event);
  });
  let captured;
  const recorded = new Promise(resolve => { captured = resolve; });
  const gate = createContinuationGate({
    checkpoint: checkpoint(), condition: 'pruned', upstream: await listen(upstream),
    record: async row => { if (row.type === 'response') captured(row); }, stop: () => {},
    maxRequests: 1, delayMs: 0,
  });
  try {
    const url = await listen(gate);
    const abort = new AbortController();
    const response = await fetch(`${url}/codex/responses`, {
      method: 'POST', body: JSON.stringify(fresh()), signal: abort.signal,
    });
    await response.body.getReader().read();
    abort.abort();
    assert.equal((await recorded).body, event);
  } finally { await close(gate); await close(upstream); }
});
