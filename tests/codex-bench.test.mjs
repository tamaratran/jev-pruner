import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { summarize, toolGroups, visibleReduction } from '../evals/codex_bench_audit.mjs';
import { hostPreviews } from '../evals/codex-preview.mjs';

test('host truncation is not credited as pruning', () => {
  const raw = 'progress\n'.repeat(10000);
  const delivered = raw.slice(0, 10000);
  const text = hostPreviews(delivered, 1000)[0];
  const result = visibleReduction(raw, delivered, { outputs: [{ text, budget: 1000 }] });
  assert.equal(result.removed_chars, 0);
  assert.equal(result.host_truncated, true);
});

test('stderr and earlier poll output count against visible savings', () => {
  const result = visibleReduction('noise\n'.repeat(1000), 'result\n', {
    outputs: [
      { text: 'stderr\n'.repeat(1000), budget: 10000 },
      { text: 'result\n', budget: 10000 },
    ],
  });
  assert.equal(result.removed_chars, 0);
  assert.equal(result.visible_chars, 7007);
  assert.throws(() => visibleReduction('abc', 'ab', {
    outputs: [{ text: 'missing', budget: 10000 }],
  }), /No observed delivery/);
});

test('polls are linked to the original wrapped command and preserve tool budgets', () => {
  const response = payload => ({ type: 'response_item', payload });
  const groups = toolGroups([
    response({ type: 'function_call', name: 'functions.exec_command', call_id: 'a',
      arguments: JSON.stringify({ cmd: 'node /opt/jev-eval/evals/codex_command.mjs -- make', max_output_tokens: 5000 }) }),
    response({ type: 'function_call_output', call_id: 'a',
      output: 'Process running with session ID 42\nOutput:\n' }),
    response({ type: 'function_call', name: 'functions.write_stdin', call_id: 'b',
      arguments: JSON.stringify({ session_id: 42, max_output_tokens: 3000 }) }),
    response({ type: 'function_call_output', call_id: 'b',
      output: 'Process exited with code 0\nFinal output:\nresult\n' }),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].outputs, [
    { text: '', budget: 5000 }, { text: 'result\n', budget: 3000 },
  ]);
});

test('failed repairs remain eligible; unchanged and invalid trials stay in overall results', () => {
  const base = {
    state: 'finished', measurement_valid: true, reward: 0, jev_requests: 0,
    jev_input_tokens: 0, pruned_outputs: 0, archive_recovery_calls: 0,
  };
  const rows = ['active', 'unchanged', 'invalid'].flatMap(task =>
    ['control', 'plugin'].map(arm => ({
      ...base, task, arm, measurement_valid: task !== 'invalid',
      pruned_outputs: arm === 'plugin' && task !== 'unchanged' ? 1 : 0,
    })));
  const report = summarize(rows);
  assert.equal(report.overall.plugin.planned, 3);
  assert.equal(report.overall.plugin.passed, 0);
  assert.deepEqual(report.qualifying_tasks, ['active']);
  assert.equal(report.effectiveness.plugin.planned, 1);
  assert.equal(summarize(rows.slice(2, 4)).effectiveness.plugin, null);
});

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
