import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('benchmark observer preserves failed stdout/stderr and keeps evidence outside workdir', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-bench-test-'));
  try {
    const cwd = join(root, 'workspace');
    const codex = join(root, 'codex');
    const evidence = join(root, 'evidence');
    await mkdir(cwd);
    await mkdir(join(codex, 'sessions'), { recursive: true });
    await writeFile(join(codex, 'sessions', 'rollout-session-123.jsonl'), '');
    const result = spawnSync(process.execPath, [
      '--import', resolve('evals/codex_observer.mjs'),
      resolve('dist/codex/run.js'), '--', process.execPath, '-e',
      'process.stdout.write("stdout\\n"); process.stderr.write("stderr\\n"); process.exitCode=7;',
    ], {
      cwd, encoding: 'utf8',
      env: { ...process.env, HOME: root, CODEX_HOME: codex, CODEX_THREAD_ID: 'session-123',
        TYPESAFE_API_KEY: '', JEV_BENCH_EVIDENCE_ROOT: evidence },
    });
    assert.equal(result.status, 7, result.stderr);
    assert.equal(result.stdout, 'stdout\n');
    assert.equal(result.stderr, 'stderr\n');
    const names = await readdir(evidence);
    const record = JSON.parse(await readFile(join(evidence, names.find(name => name.endsWith('.json')))));
    assert.equal(record.child_code, 7);
    assert.equal(record.wrapper_code, 7);
    assert.equal(await readFile(join(evidence, `${record.id}.raw`), 'utf8'), result.stdout);
    assert.equal(await readFile(join(evidence, `${record.id}.delivered`), 'utf8'), result.stdout);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(root, { recursive: true });
  }
});
