import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { performance } from 'node:perf_hooks';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPreviews } from './codex-preview.mjs';
import { fingerprint, initialRequest, runtimeManifest, workspaceManifest } from './codex_start.mjs';
import { spawnCodex } from './codex_gate.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
const hop = ['host', 'connection', 'transfer-encoding', 'content-length', 'content-encoding'];

export function checkpointRequest(checkpoint, condition, suffix = []) {
  assert(['native', 'pruned'].includes(condition), 'Unknown checkpoint condition');
  const request = structuredClone(checkpoint.request);
  request.input[checkpoint.target].output = checkpoint.outputs[condition];
  request.input.push(...structuredClone(suffix));
  return request;
}

export function commonCheckpointHash(checkpoint, condition) {
  const request = checkpointRequest(checkpoint, condition);
  request.input[checkpoint.target].output = '<intervention>';
  return fingerprint(request);
}

export function createRewriter(checkpoint) {
  let initial;
  return body => {
    assert(!body.previous_response_id, 'Stateful requests cannot replay a checkpoint');
    if (!initial) {
      initialRequest(body);
      for (const key of ['model', 'tools', 'instructions', 'reasoning', 'tool_choice',
        'parallel_tool_calls', 'include', 'store', 'stream', 'text']) {
        assert.equal(fingerprint({ value: body[key] }), fingerprint({ value: checkpoint.request[key] }),
          `Runtime request differs: ${key}`);
      }
      initial = structuredClone(body.input);
    }
    assert.deepEqual(body.input.slice(0, initial.length), initial,
      'Initial history changed or was compacted');
    return body.input.slice(initial.length);
  };
}

export async function prepareCheckpoint(agent, captureId, callId, destination) {
  const start = await json(join(agent, 'start.json'));
  assert.equal(start.status, 'accepted');
  const sessionPaths = (await readdir(join(agent, 'sessions'), { recursive: true }))
    .filter(path => path.endsWith('.jsonl'));
  assert.equal(sessionPaths.length, 1);
  const events = (await readFile(join(agent, 'sessions', sessionPaths[0]), 'utf8'))
    .trim().split('\n').map(JSON.parse);
  const items = events.filter(event => event.type === 'response_item').map(event => event.payload);
  const target = items.findIndex(item => item.type === 'function_call_output' && item.call_id === callId);
  assert(target >= start.start.request.input.length);
  const prefix = items.slice(0, target + 1);
  assert.equal(fingerprint(initialRequest({
    ...start.start.request, input: prefix.slice(0, start.start.request.input.length),
  })), fingerprint(start.start.request), 'Transcript prefix differs from recorded initial request');
  const record = await json(join(agent, 'observer', `${captureId}.json`));
  assert.deepEqual(record.command, ['tar', '-tzf', '/workdir/coreutils.tar.gz']);
  assert.equal(record.child_code, 0);
  const raw = await readFile(join(agent, 'observer', `${captureId}.raw`), 'utf8');
  const delivered = await readFile(join(agent, 'observer', `${captureId}.delivered`), 'utf8');
  assert(record.archive_exact && record.archive.startsWith('/workdir/.jev-pruner/'));
  const pruned = prefix[target].output;
  const preview = hostPreviews(delivered, 10000).find(text => pruned.endsWith(text));
  assert(preview, 'Recorded result does not match host preview');
  const nativePreview = hostPreviews(raw, 10000).at(-1);
  const header = pruned.slice(0, pruned.length - preview.length);
  const native = header.replaceAll(String(Math.ceil(Buffer.byteLength(delivered) / 4)),
    String(Math.ceil(Buffer.byteLength(raw) / 4))) + nativePreview;
  assert.notEqual(native, pruned);
  for (const item of prefix) if (item.id === null) delete item.id;
  const checkpoint = {
    schema: 1, target, request: { ...start.start.request, input: prefix },
    outputs: { native, pruned }, archive: record.archive, raw,
    original_runtime: start.start.runtime,
    history_items: prefix.length,
    source: { captureId, callId, start_sha256: start.sha256 },
  };
  assert.equal(commonCheckpointHash(checkpoint, 'native'), commonCheckpointHash(checkpoint, 'pruned'));
  await mkdir(destination, { mode: 0o700 });
  await save(join(destination, 'checkpoint.json'), checkpoint);
  await save(join(destination, 'checkpoint-summary.json'), {
    schema: 1, history_items: prefix.length, common_sha256: commonCheckpointHash(checkpoint, 'native'),
    requests: Object.fromEntries(['native', 'pruned'].map(condition =>
      [condition, fingerprint(checkpointRequest(checkpoint, condition))])),
    preview_chars: { native: native.length, pruned: pruned.length },
    source: checkpoint.source, original_workspace: checkpoint.original_runtime.workspace,
    recovery_archive_in_both_conditions: true,
  });
}

export function createContinuationGate({ checkpoint, condition, upstream, record, stop, maxRequests,
  delayMs = 250, probe = false }) {
  const rewrite = createRewriter(checkpoint);
  let index = 0;
  let failed = false;
  return createServer(async (incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/api/codex/settings/user') {
      outgoing.writeHead(404).end('{}');
      return;
    }
    try {
      assert(!failed, 'Gate previously rejected a request');
      assert(incoming.method === 'POST' && incoming.url === '/codex/responses',
        'Only inference is supported; compaction is not allowed');
      assert(!incoming.headers['content-encoding'], 'Compressed request');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of incoming) {
        bytes += chunk.length;
        assert(bytes <= 64 * 1024 * 1024, 'Request too large');
        chunks.push(chunk);
      }
      const suffix = rewrite(JSON.parse(Buffer.concat(chunks)));
      const request = checkpointRequest(checkpoint, condition, suffix);
      const number = ++index;
      await record({ type: 'request', number, sha256: fingerprint(request), request });
      assert(number <= maxRequests, 'Predeclared request cap reached');
      if (probe) {
        await record({ type: 'probe_accepted', number });
        outgoing.writeHead(409).end('Offline checkpoint probe completed');
        stop();
        return;
      }
      const began = performance.now();
      if (number === 1) await delay(delayMs);
      await record({ type: 'forward', number, requested_delay_ms: number === 1 ? delayMs : 0,
        actual_delay_ms: performance.now() - began });
      const url = new URL(`${upstream}${incoming.url}`);
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([key]) => !hop.includes(key)));
      headers['accept-encoding'] = 'identity';
      let finishResponse = () => {};
      const forward = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: 'POST', headers,
      }, response => {
        outgoing.writeHead(response.statusCode, Object.fromEntries(Object.entries(response.headers)
          .filter(([key]) => !hop.includes(key))));
        const captured = [];
        response.on('data', chunk => captured.push(chunk));
        let recorded = false;
        finishResponse = () => {
          if (recorded) return;
          recorded = true;
          void record({ type: 'response', number, status: response.statusCode,
            body: Buffer.concat(captured).toString() });
        };
        response.once('end', finishResponse);
        response.once('close', finishResponse);
        response.pipe(outgoing);
      });
      forward.on('error', async error => {
        await record({ type: 'transport_error', number, error: error.message });
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end('Upstream transport failed');
      });
      outgoing.on('close', () => { finishResponse(); forward.destroy(); });
      forward.end(JSON.stringify(request));
    } catch (error) {
      failed = true;
      await record({ type: 'rejected', error: error.message });
      if (!outgoing.headersSent) outgoing.writeHead(409);
      outgoing.end('Checkpoint gate rejected request');
      stop();
    }
  });
}

export async function runCheckpoint(condition, probe = false, liveProbe = false) {
  const root = '/opt/jev-eval/private';
  const checkpoint = await json(join(root, 'checkpoint.json'));
  assert.equal(fingerprint(await workspaceManifest('/workdir')),
    fingerprint(checkpoint.original_runtime.workspace), 'Source workspace differs');
  await mkdir(dirname(checkpoint.archive), { mode: 0o700, recursive: true });
  await writeFile(checkpoint.archive, checkpoint.raw, { mode: 0o600, flag: 'wx' });
  const args = checkpoint.original_runtime.args;
  const runtime = await runtimeManifest(args, root);
  assert.equal(runtime.codex, checkpoint.original_runtime.codex);
  assert.equal(runtime.node, checkpoint.original_runtime.node);
  for (const name of ['gcc', 'cc', 'make', 'bash', 'sh']) {
    assert.deepEqual(runtime.binaries[name], checkpoint.original_runtime.binaries[name], `${name} differs`);
  }
  const reference = await json(join(root, 'expected-runtime.json')).catch(error => {
    if (probe && error.code === 'ENOENT') return null;
    throw error;
  });
  if (reference) assert.equal(fingerprint(runtime), fingerprint(reference), 'Continuation runtimes differ');
  await save(join(root, 'runtime.json'), runtime);
  const log = join(root, 'requests.jsonl');
  let pending = Promise.resolve();
  const record = value => {
    pending = pending.then(() => appendFile(log, JSON.stringify(value) + '\n', { mode: 0o600 }));
    return pending;
  };
  let child;
  let stopped = false;
  const stop = () => { stopped = true; child?.kill('SIGTERM'); };
  const server = createContinuationGate({
    checkpoint, condition, probe, upstream: 'https://chatgpt.com/backend-api',
    maxRequests: liveProbe ? 1 : 65, record, stop,
  });
  await new Promise(resolve => server.listen(49371, '127.0.0.1', resolve));
  try {
    child = spawnCodex(args);
    const timer = setTimeout(stop, 45 * 60 * 1000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    clearTimeout(timer);
    await pending;
    await save(join(root, 'exit.json'), { code, stopped, probe });
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare') await prepareCheckpoint(...args);
  else if (command === 'run') await runCheckpoint(args[0], args.includes('--probe'), args.includes('--live-probe'));
  else throw new Error('Expected prepare or run');
}
