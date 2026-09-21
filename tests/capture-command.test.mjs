import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

const wrapper = resolve('evals/capture_command.mjs');

test('capture preserves binary streams and failed-command exit status', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-capture-test-'));
  try {
    const expected = Buffer.from([0, 255, 13, 10, 65]);
    const result = spawnSync(process.execPath, [
      wrapper, '--', process.execPath, '-e',
      'process.stdout.write(Buffer.from([0,255,13,10,65])); process.stderr.write("diagnostic\\n"); process.exitCode=7;',
    ], { env: { ...process.env, JEV_BENCH_EVIDENCE_ROOT: root } });
    assert.equal(result.status, 7);
    assert.deepEqual(result.stdout, expected);
    assert.equal(result.stderr.toString(), 'diagnostic\n');
    const files = await readdir(root);
    const metadata = files.find(file => file.endsWith('.json'));
    const record = JSON.parse(await readFile(join(root, metadata), 'utf8'));
    assert.equal(record.complete, true);
    assert.equal(record.code, 7);
    assert.deepEqual(await readFile(join(root, `${record.id}.stdout`)), expected);
    assert.equal(await readFile(join(root, `${record.id}.stderr`), 'utf8'), 'diagnostic\n');
  } finally {
    await rm(root, { recursive: true });
  }
});

test('a missing executable leaves a completed failure record', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-capture-test-'));
  try {
    const result = spawnSync(process.execPath, [
      wrapper, '--', '/nonexistent/jev-capture-test',
    ], { env: { ...process.env, JEV_BENCH_EVIDENCE_ROOT: root } });
    assert.equal(result.status, 127);
    const files = await readdir(root);
    const record = JSON.parse(await readFile(
      join(root, files.find(file => file.endsWith('.json'))), 'utf8',
    ));
    assert.equal(record.complete, true);
    assert.match(record.error, /ENOENT/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('capture preserves signal termination after flushing evidence', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-capture-test-'));
  try {
    const result = spawnSync(process.execPath, [
      wrapper, '--', process.execPath, '-e', 'process.kill(process.pid, "SIGTERM");',
    ], { env: { ...process.env, JEV_BENCH_EVIDENCE_ROOT: root }, timeout: 5000 });
    assert.equal(result.signal, 'SIGTERM');
    const files = await readdir(root);
    const record = JSON.parse(await readFile(
      join(root, files.find(file => file.endsWith('.json'))), 'utf8',
    ));
    assert.equal(record.complete, true);
    assert.equal(record.signal, 'SIGTERM');
  } finally {
    await rm(root, { recursive: true });
  }
});
