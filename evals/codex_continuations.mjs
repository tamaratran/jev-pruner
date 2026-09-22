import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fingerprint } from './codex_start.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, data) => writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
const docker = args => execFileSync('docker', args, {
  encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
}).trim();

async function command(args, stdout, stderr, timeout) {
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const out = createWriteStream(stdout, { mode: 0o600, flags: 'wx' });
  const err = createWriteStream(stderr, { mode: 0o600, flags: 'wx' });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', async code => {
        await Promise.all([out, err].map(stream => stream.closed
          ? Promise.resolve() : new Promise(done => stream.once('close', done))));
        resolve(code);
      });
    });
  } finally { clearTimeout(timer); }
}

export async function plan(root, image, catalog, tests) {
  const seed = 'jev-alpine-checkpoint-v1';
  const attempts = [];
  for (let block = 1; block <= 4; block++) {
    const rows = ['native-a', 'native-b', 'pruned'].map(group => ({
      id: `block-${block}-${group}`, block, group,
      condition: group.startsWith('native') ? 'native' : 'pruned',
    }));
    rows.sort((a, b) => fingerprint({ seed, id: a.id }).localeCompare(fingerprint({ seed, id: b.id })));
    attempts.push(...rows);
  }
  const checkpoint = await json(join(root, 'checkpoint.json'));
  await save(join(root, 'protocol.json'), {
    schema: 1, seed, attempts, image: docker(['image', 'inspect', image, '--format', '{{.Id}}']),
    checkpoint_sha256: fingerprint(checkpoint),
    catalog: resolve(catalog), catalog_sha256: fingerprint(await json(catalog)),
    tests: resolve(tests), test_sha256: fingerprint(await readFile(join(tests, 'test_outputs.py'), 'utf8')),
    concurrency: 3, cpus: 0.5, memory: '2g', max_requests: 65, deadline_minutes: 45,
    intervention_delay_ms: 250, later_pruning: false,
    primary: ['configure_gnu89_omission', 'requests', 'input_tokens', 'verifier_success'],
    secondary: ['source_inspections', 'builds', 'patches', 'polls', 'verification_commands'],
    prices_per_million: { input: 5, output: 30 },
    exclusions: 'No replacements. Failures, rejected starts, caps and quota-blocked attempts remain.',
    scope: 'One historical checkpoint; encrypted history is replayed opaquely, never decoded or published.',
  });
}

export async function runAttempt(root, attempt, { probe = false, liveProbe = false } = {}) {
  const protocol = await json(join(root, 'protocol.json'));
  assert.equal(protocol.checkpoint_sha256, fingerprint(await json(join(root, 'checkpoint.json'))));
  assert.equal(protocol.catalog_sha256, fingerprint(await json(protocol.catalog)));
  const directory = join(root, attempt.id);
  await mkdir(directory, { mode: 0o700 });
  const container = docker(['create', '--cpus', String(protocol.cpus), '--memory', protocol.memory,
    '--hostname', 'checkpoint', protocol.image]);
  const result = { ...attempt, probe, live_probe: liveProbe, began: new Date().toISOString() };
  try {
    for (const [local, remote] of [
      [join(root, 'checkpoint.json'), '/opt/jev-eval/private/checkpoint.json'],
      [protocol.catalog, '/opt/jev-eval/private/models.json'],
      [process.env.JEV_CODEX_AUTH_FILE, '/opt/jev-eval/codex-home/auth.json'],
      ...(!probe ? [[join(root, 'expected-runtime.json'), '/opt/jev-eval/private/expected-runtime.json']] : []),
    ]) {
      assert(local, 'Set JEV_CODEX_AUTH_FILE to the existing subscription login');
      docker(['cp', local, `${container}:${remote}`]);
    }
    docker(['start', container]);
    result.agent_code = await command(['exec', container, 'node', '/opt/jev-eval/evals/codex_checkpoint.mjs',
      'run', attempt.condition, ...(probe ? ['--probe'] : []), ...(liveProbe ? ['--live-probe'] : [])],
    join(directory, 'codex.jsonl'), join(directory, 'agent.stderr'), 47 * 60 * 1000);
    await mkdir(join(directory, 'private'), { mode: 0o700 });
    docker(['cp', `${container}:/opt/jev-eval/private/.`, join(directory, 'private')]);
    docker(['cp', `${container}:/opt/jev-eval/evidence`, join(directory, 'private/observer')]);
    docker(['cp', `${container}:/opt/jev-eval/codex-home/sessions`, join(directory, 'private/sessions')]);
    const records = (await readFile(join(directory, 'private/requests.jsonl'), 'utf8'))
      .trim().split('\n').map(JSON.parse);
    const exit = await json(join(directory, 'private/exit.json'));
    const rejection = records.find(row => row.type === 'rejected');
    result.status = rejection?.error.includes('request cap') ? 'request_cap'
      : rejection ? 'gate_rejected' : exit.stopped ? 'deadline' : 'agent_finished';
    if (probe) {
      assert(records.some(row => row.type === 'probe_accepted'), 'Offline probe did not accept request');
      result.status = 'probe_accepted';
    } else if (!liveProbe) {
      assert.equal(protocol.test_sha256, fingerprint(await readFile(join(protocol.tests, 'test_outputs.py'), 'utf8')));
      docker(['cp', protocol.tests, `${container}:/tests`]);
      docker(['exec', container, 'mkdir', '-p', '/logs/verifier']);
      result.verifier_code = await command(['exec', container, 'bash', '/tests/test.sh'],
        join(directory, 'verifier.stdout'), join(directory, 'verifier.stderr'), 10 * 60 * 1000);
      docker(['cp', `${container}:/logs/verifier`, join(directory, 'verifier')]);
      result.reward = Number(await readFile(join(directory, 'verifier/reward.txt'), 'utf8'));
    }
  } catch (error) {
    result.status = 'error';
    result.error = error.message;
    try { docker(['cp', `${container}:/opt/jev-eval/private/.`, join(directory, 'private')]); } catch {}
  } finally {
    result.ended = new Date().toISOString();
    await save(join(directory, 'result.json'), result);
    docker(['stop', '--time', '5', container]);
    docker(['rm', container]);
  }
  console.log(JSON.stringify({ id: result.id, status: result.status, reward: result.reward }));
  return result;
}

export async function runBatch(root) {
  const protocol = await json(join(root, 'protocol.json'));
  await save(join(root, 'launch.json'), { at: new Date().toISOString(), protocol_sha256: fingerprint(protocol) });
  let blocked = false;
  for (let block = 1; block <= 4; block++) {
    const rows = protocol.attempts.filter(row => row.block === block);
    if (blocked) {
      for (const row of rows) {
        await mkdir(join(root, row.id), { mode: 0o700 });
        await save(join(root, row.id, 'result.json'), { ...row, status: 'blocked_by_previous_error' });
      }
      continue;
    }
    const results = await Promise.all(rows.map(row => runAttempt(root, row)));
    for (const result of results) {
      if (result.status === 'error' || result.status === 'gate_rejected') blocked = true;
      const text = await readFile(join(root, result.id, 'codex.jsonl'), 'utf8');
      if (/usage_limit_reached|usage limit|rate_limit_exceeded|insufficient_quota|token_expired|refresh_token_reused/i.test(text)) blocked = true;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, root, ...args] = process.argv.slice(2);
  if (command === 'plan') await plan(resolve(root), ...args);
  else if (command === 'probe' || command === 'live-probe') {
    await runAttempt(resolve(root), { id: args[0], condition: args[1] },
      { probe: command === 'probe', liveProbe: command === 'live-probe' });
  } else if (command === 'run') await runBatch(resolve(root));
  else throw new Error('Expected plan, probe, live-probe or run');
}
