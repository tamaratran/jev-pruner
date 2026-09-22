import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnCodex } from './codex_gate.mjs';
import { fingerprint } from './codex_start.mjs';

const root = '/opt/jev-eval/private';
const checkpoint = JSON.parse(await readFile(`${root}/checkpoint.json`, 'utf8'));
let child;
let count = 0;
let matched = false;
const normalize = text => text.replace(/^Chunk ID: .*\nWall time: .*\n/, '');
const server = createServer(async (request, response) => {
  if (request.method === 'GET') { response.writeHead(404).end('{}'); return; }
  try {
    assert.equal(request.url, '/codex/responses');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const output = body.input.findLast(item => item.type === 'function_call_output')?.output;
    if (output?.includes('Process exited with code')) {
      assert.equal(normalize(output), normalize(checkpoint.outputs.native),
        'Reconstruction differs from real Codex native formatting');
      await writeFile(`${root}/formatter-check.json`, JSON.stringify({
        matched: true, real_native_sha256: fingerprint(normalize(output)),
        reconstructed_sha256: fingerprint(normalize(checkpoint.outputs.native)),
        chars: output.length, model_requests: 0, mocked_responses: count,
      }), { mode: 0o600, flag: 'wx' });
      matched = true;
      response.writeHead(409).end('Native formatter validation complete');
      child.kill('SIGTERM');
      return;
    }
    assert(++count <= 10, 'Too many tool polls');
    const session = /Process running with session ID (\d+)/.exec(output ?? '')?.[1];
    const item = {
      id: `fc_probe_${count}`, type: 'function_call', status: 'completed', call_id: `call_probe_${count}`,
      name: session ? 'write_stdin' : 'exec_command',
      arguments: JSON.stringify(session ? { session_id: Number(session), chars: '', yield_time_ms: 1000, max_output_tokens: 10000 } : {
        cmd: 'node /opt/jev-eval/evals/codex_command.mjs -- tar -tzf /workdir/coreutils.tar.gz',
        workdir: '/workdir', yield_time_ms: 1000, max_output_tokens: 10000,
      }),
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of [
      { type: 'response.created', response: { id: `resp_probe_${count}` } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: {
        id: `resp_probe_${count}`, output: [],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) {
    console.error(error.message);
    response.writeHead(409).end('Native formatter validation failed');
    child?.kill('SIGTERM');
  }
});
await new Promise(resolve => server.listen(49371, '127.0.0.1', resolve));
try {
  child = spawnCodex(checkpoint.original_runtime.args);
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  await new Promise(resolve => child.once('close', resolve));
  clearTimeout(timer);
  assert(matched, 'Native formatter probe did not match');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
