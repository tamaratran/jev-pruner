import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { verifyTask, summarize } from '../evals/codex_bench_audit.mjs';

test('local task audit rejects changed verifier content and wrong task paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'compilebench-audit-'));
  try {
    const task = join(root, 'tasks', 'jq-r1');
    await mkdir(task, { recursive: true });
    const content = 'original verifier';
    await writeFile(join(task, 'test.sh'), content);
    const protocol = {
      local_task_root: join(root, 'tasks'),
      task_sha256: {
        'tasks/jq-r1/test.sh': createHash('sha256').update(content).digest('hex'),
      },
    };
    await verifyTask({ task_id: { path: task } }, { task: 'jq-r1' }, protocol);
    await assert.rejects(verifyTask({ task_id: { path: '/other/task' } },
      { task: 'jq-r1' }, protocol), /path mismatch/);
    await writeFile(join(task, 'test.sh'), 'modified verifier');
    await assert.rejects(verifyTask({ task_id: { path: task } },
      { task: 'jq-r1' }, protocol), /Task file changed/);
  } finally {
    await rm(root, { recursive: true });
  }
});

test('repeated task aliases retain failed repairs and exclude unchanged pairs', () => {
  const rows = ['jq-r1', 'jq-r2', 'jq-r3'].flatMap((task, index) =>
    ['control', 'plugin'].map(arm => ({
      task, source_task: 'jq', repetition: index + 1, arm,
      state: 'finished', measurement_valid: true, model_usage_valid: true,
      reward: index === 0 && arm === 'plugin' ? 0 : 1,
      normalized_cost_usd: 1, jev_input_tokens: 0, jev_requests: 0,
      pruned_outputs: index < 2 && arm === 'plugin' ? 1 : 0,
      archive_recovery_calls: 0,
    })));
  const result = summarize(rows);
  assert.deepEqual(result.qualifying_tasks, ['jq-r1', 'jq-r2']);
  assert.equal(result.overall.plugin.planned, 3);
  assert.equal(result.effectiveness.plugin.planned, 2);
  assert.equal(result.effectiveness.plugin.failed, 1);
  assert.equal(result.effectiveness.control.passed, 2);
});
