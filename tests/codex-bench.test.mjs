import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';
import { auditTrial, summarize, toolGroups, visibleReduction } from '../evals/codex_bench_audit.mjs';
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

test('per-call preview requests cannot exceed the frozen global output cap', () => {
  const groups = toolGroups([
    { type: 'response_item', payload: {
      type: 'function_call', name: 'functions.exec_command', call_id: 'a',
      arguments: JSON.stringify({
        cmd: 'node /opt/jev-eval/evals/codex_command.mjs -- make',
        max_output_tokens: 80000,
      }),
    } },
    { type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'a', output: 'Output:\ncompiled\n',
    } },
  ]);
  assert.equal(groups[0].outputs[0].budget, 10000);
});

async function auditFixture(root, arm, incomplete) {
  const agent = join(root, 'jobs', 'fixture', 'task__trial', 'agent');
  const observer = join(agent, 'observer');
  await mkdir(observer, { recursive: true });
  await mkdir(join(agent, 'sessions'));
  const usage = { input_tokens: 200, cached_input_tokens: 100, output_tokens: 20 };
  const transcript = [
    { type: 'turn_context', payload: { model: 'gpt-5.5' } },
    { type: 'response_item', payload: {
      type: 'function_call', name: 'functions.exec_command', call_id: 'a',
      arguments: JSON.stringify({
        cmd: 'for item in 1 2; do node /opt/jev-eval/evals/codex_command.mjs -- make; done | tail -1',
      }),
    } },
    { type: 'response_item', payload: {
      type: 'function_call_output', call_id: 'a',
      output: 'Process exited with code 0\nFinal output:\nfiltered\n',
    } },
    { type: 'event_msg', payload: {
      type: 'token_count', info: {
        total_token_usage: { ...usage, reasoning_output_tokens: 10 },
      },
    } },
  ];
  await writeFile(join(agent, 'sessions', 'session.jsonl'), transcript.map(JSON.stringify).join('\n'));
  await writeFile(join(agent, 'codex.txt'), JSON.stringify({ type: 'turn.completed', usage }));
  await writeFile(join(agent, 'eval-settings.json'), JSON.stringify({ arm, instructions: 'fixture' }));
  await writeFile(join(agent, '..', 'result.json'), JSON.stringify({
    task_id: { git_commit_id: 'revision' }, verifier_result: { rewards: { reward: 0 } },
  }));
  for (const id of ['one', 'two']) {
    for (const ext of ['raw', 'delivered']) {
      await writeFile(join(observer, `${id}.${ext}`), 'compiler output\nfiltered\n');
    }
    if (incomplete && id === 'two') continue;
    await writeFile(join(observer, `${id}.json`), JSON.stringify({
      marker: 'JEV_EVAL_PRIVATE_EVIDENCE_V1', id, started: 1,
      child_code: 0, wrapper_code: 0, command: ['make'],
    }));
  }
  return auditTrial(root, { task: 'task', job_name: 'fixture', state: 'finished', arm }, {
    benchmark_commit: 'revision', instructions: 'fixture',
  });
}

test('unchanged captures inside loops and pipes cannot create pruning credit', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-bench-audit-test-'));
  try {
    const row = await auditFixture(root, 'plugin', false);
    assert.equal(row.measurement_valid, true, row.measurement_issues.join('\n'));
    assert.equal(row.wrapped_commands, 2);
    assert.equal(row.wrapper_tool_calls, 1);
    assert.equal(row.pruned_outputs, 0);
    assert.equal(row.outputs.length, 2);
    assert(row.outputs.every(output => output.removed_chars === 0));
  } finally {
    await rm(root, { recursive: true });
  }
});

test('incomplete captures invalidate effectiveness without discarding reconciled accounting', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-bench-audit-test-'));
  try {
    const row = await auditFixture(root, 'control', true);
    assert.equal(row.measurement_valid, false);
    assert.deepEqual(row.incomplete_captures, ['two']);
    assert.equal(row.model_usage_valid, true);
    assert.equal(row.normalized_cost_usd, 0.0016);
    assert.equal(summarize([row]).overall.control.cost_available, 1);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('an interrupted plugin capture leaves combined cost unknown rather than zero', async () => {
  const root = await mkdtemp(join(homedir(), '.jev-bench-audit-test-'));
  try {
    const row = await auditFixture(root, 'plugin', true);
    assert.equal(row.measurement_valid, false);
    assert.equal(row.jev_usage_complete, false);
    assert.equal(row.model_normalized_cost_usd, 0.0016);
    assert.equal(row.normalized_cost_usd, undefined);
    assert.equal(summarize([row]).overall.plugin.cost_available, 0);
    assert.equal(summarize([row]).overall.plugin.normalized_cost_usd_lower_bound, 0.0016);
  } finally {
    await rm(root, { recursive: true });
  }
});

test.each(['separate', 'shared', 'ambiguous'])('pruned captures require unique delivery groups: %s', async mode => {
  const root = await mkdtemp(join(homedir(), '.jev-bench-audit-test-'));
  try {
    await auditFixture(root, 'plugin', false);
    const agent = join(root, 'jobs', 'fixture', 'task__trial', 'agent');
    const delivered = [];
    for (const id of ['one', 'two']) {
      const path = join(agent, 'observer', `${id}.json`);
      const record = JSON.parse(await readFile(path, 'utf8'));
      record.archive = `/app/.jev-pruner/${id}.txt`;
      record.archive_exact = true;
      const output = `result: ok\n[fast-jev-output full output: ${record.archive} (Read or grep it if needed)]`;
      delivered.push(output);
      await writeFile(path, JSON.stringify(record));
      await writeFile(join(agent, 'observer', `${id}.raw`), 'download noise\n'.repeat(2000) + 'result: ok\n');
      await writeFile(join(agent, 'observer', `${id}.delivered`), output);
    }
    const path = join(agent, 'sessions', 'session.jsonl');
    const events = (await readFile(path, 'utf8')).split('\n').map(JSON.parse);
    events[2].payload.output = `Process running with session ID 42\nOutput:\n${delivered[0]}`;
    events.splice(3, 0,
      { type: 'response_item', payload: {
        type: 'function_call', call_id: 'b',
        name: mode === 'shared' ? 'functions.write_stdin' : 'functions.exec_command',
        arguments: JSON.stringify(mode === 'shared' ? { session_id: 42 } : {
          cmd: 'node /opt/jev-eval/evals/codex_command.mjs -- make',
        }),
      } },
      { type: 'response_item', payload: {
        type: 'function_call_output', call_id: 'b',
        output: `Process exited with code 0\nFinal output:\n${delivered[1]}${mode === 'ambiguous' ? delivered[0] : ''}`,
      } },
    );
    await writeFile(path, events.map(JSON.stringify).join('\n'));
    const row = await auditTrial(root, { task: 'task', job_name: 'fixture', state: 'finished', arm: 'plugin' }, {
      benchmark_commit: 'revision', instructions: 'fixture',
    });
    assert.equal(row.measurement_valid, mode === 'separate', row.measurement_issues.join('\n'));
    assert.equal(row.model_usage_valid, true);
    if (mode === 'separate') {
      assert.equal(row.pruned_outputs, 2);
    } else {
      assert(row.measurement_issues.some(issue => issue.includes(
        mode === 'shared' ? 'Multiple pruned captures share' : 'Expected one native group',
      )));
      const control = { ...row, arm: 'control', measurement_valid: true, pruned_outputs: 0 };
      assert.deepEqual(summarize([control, row]).qualifying_tasks, []);
    }
  } finally {
    await rm(root, { recursive: true });
  }
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
