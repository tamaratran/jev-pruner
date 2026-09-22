import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprint, initialRequest, runtimeManifest } from './codex_start.mjs';

const hopHeaders = ['host', 'connection', 'transfer-encoding', 'content-length'];

export function spawnCodex(args) {
  const child = spawn(args[0], args.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
  child.stdout.pipe(process.stdout, { end: false });
  child.stderr.pipe(process.stderr, { end: false });
  return child;
}

export function createGate({ upstream, runtime, expected, record, onReject }) {
  let first = true;
  let accepted = false;
  let rejected = false;
  const server = createServer(async (incoming, outgoing) => {
    if (incoming.method === 'GET' && incoming.url === '/api/codex/settings/user') {
      outgoing.writeHead(404);
      outgoing.end('{}');
      return;
    }
    try {
      assert(!rejected, 'Starting conditions rejected');
      assert(incoming.method === 'POST' &&
        ['/codex/responses', '/codex/responses/compact'].includes(incoming.url),
      'Unexpected Codex endpoint');
      assert(!incoming.headers['content-encoding'], 'Request compression must be disabled');
      let body;
      assert(first || accepted, 'Concurrent initial requests are not supported');
      if (first) {
        first = false;
        assert(incoming.url === '/codex/responses', 'First request must be inference');
        const chunks = [];
        let bytes = 0;
        for await (const chunk of incoming) {
          bytes += chunk.length;
          assert(bytes <= 64 * 1024 * 1024, 'Initial request too large');
          chunks.push(chunk);
        }
        body = Buffer.concat(chunks);
        const request = initialRequest(JSON.parse(body));
        const start = { schema: 1, runtime, request };
        const sha256 = fingerprint(start);
        const matched = !expected || fingerprint(expected.start) === sha256;
        await record({ start, sha256, status: matched ? 'accepted' : 'rejected',
          reference: expected?.sha256 ?? null });
        assert(matched, 'Starting conditions differ from the paired reference');
        accepted = true;
      }
      const url = new URL(`${upstream}${incoming.url}`);
      const headers = Object.fromEntries(Object.entries(incoming.headers)
        .filter(([key]) => !hopHeaders.includes(key)));
      const forward = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: incoming.method, headers,
      }, response => {
        outgoing.writeHead(response.statusCode, Object.fromEntries(Object.entries(response.headers)
          .filter(([key]) => !hopHeaders.includes(key))));
        response.pipe(outgoing);
      });
      forward.on('error', () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end('Upstream transport failed');
      });
      outgoing.on('close', () => forward.destroy());
      if (body) forward.end(body);
      else incoming.pipe(forward);
    } catch (error) {
      rejected = true;
      await record({ status: 'rejected', error: error.message }, true);
      outgoing.writeHead(409, { 'content-type': 'application/json' });
      outgoing.end(JSON.stringify({ error: { message: 'Evaluation preflight rejected starting conditions' } }));
      onReject();
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  return server;
}

export async function runGated(args) {
  const root = '/opt/jev-eval/private';
  const evidence = join(root, 'start.json');
  const record = async (value, append = false) => {
    const previous = append ? JSON.parse(await readFile(evidence, 'utf8').catch(() => '{}')) : {};
    await writeFile(evidence, JSON.stringify({
      marker: 'JEV_EVAL_PRIVATE_EVIDENCE_V1', ...previous, ...value,
    }, null, 2), { mode: 0o600 });
  };
  let expected;
  try {
    expected = JSON.parse(await readFile(join(root, 'expected-start.json'), 'utf8'));
    assert(expected.status === 'accepted' && expected.sha256 === fingerprint(expected.start),
      'Invalid paired reference');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const runtime = await runtimeManifest(args, root);
  if (expected && fingerprint(runtime) !== fingerprint(expected.start.runtime)) {
    await record({ status: 'rejected', error: 'Runtime differs from paired reference', runtime });
    return 78;
  }
  let child;
  let rejected = false;
  const server = createGate({
    upstream: 'https://chatgpt.com/backend-api', runtime, expected, record,
    onReject: () => { rejected = true; child?.kill('SIGTERM'); },
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(49371, '127.0.0.1', resolve);
  });
  try {
    child = spawnCodex(args);
    const forward = signal => child.kill(signal);
    const interrupt = () => forward('SIGINT');
    const terminate = () => forward('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    try {
      const code = await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => resolve(code ?? 1));
      });
      return rejected ? 78 : code;
    } finally {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    assert(process.argv[2] === '--', 'Expected -- before Codex command');
    process.exitCode = await runGated(process.argv.slice(3));
  } catch (error) {
    await writeFile('/opt/jev-eval/private/start.json',
      JSON.stringify({ status: 'rejected', error: error.message }), { mode: 0o600 });
    console.error('Evaluation preflight failed; see private start evidence');
    process.exitCode = 78;
  }
}
