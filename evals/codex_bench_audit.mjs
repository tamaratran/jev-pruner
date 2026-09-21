import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hostPreviews } from './codex-preview.mjs';
import { assertNoEvidenceLeak } from './observer/evidence-isolation.mjs';

const privatePaths = ['/opt/jev-eval/evidence', '/opt/jev-eval/private'];
const wrapper = '/opt/jev-eval/evals/codex_command.mjs';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const exists = async path => (await readdir(path).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
}));
const events = text => text.split('\n').flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const payloads = transcript => transcript.filter(event => event.type === 'response_item').map(event => event.payload);
const finalOutput = text => text.replace(/^[\s\S]*?\n(?:Final output|Output):\n/, '');

export function toolGroups(transcript) {
  const calls = new Map();
  const groups = [];
  for (const item of payloads(transcript)) {
    if (item.type === 'function_call') {
      let args;
      try { args = JSON.parse(item.arguments); } catch { continue; }
      const command = args.cmd ?? args.command ?? '';
      const text = typeof command === 'string' ? command : JSON.stringify(command);
      let group;
      if (text.includes(wrapper)) {
        group = { command: text, outputs: [], session: null };
        groups.push(group);
      } else if (item.name.endsWith('write_stdin')) {
        group = groups.find(candidate => String(candidate.session) === String(args.session_id));
      }
      if (group) calls.set(item.call_id, { group, budget: Math.min(args.max_output_tokens ?? 10000, 10000) });
    } else if (item.type === 'function_call_output' && calls.has(item.call_id)) {
      const { group, budget } = calls.get(item.call_id);
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      group.session = /session ID (\d+)/.exec(output)?.[1] ?? group.session;
      group.outputs.push({ text: finalOutput(output), budget });
    }
  }
  return groups;
}

export function visibleReduction(raw, delivered, group) {
  const matches = group.outputs.filter(output =>
    hostPreviews(delivered, output.budget).some(preview => output.text.endsWith(preview)));
  assert(matches.length > 0 || delivered === '', 'No observed delivery/host-preview match');
  if (delivered === '') return {
    native_chars: 0,
    visible_chars: group.outputs.reduce((sum, item) => sum + item.text.length, 0),
    removed_chars: 0,
  };
  const output = matches.at(-1);
  const native = Math.min(...hostPreviews(raw, output.budget).map(text => text.length));
  const visible = group.outputs.reduce((sum, item) => sum + item.text.length, 0);
  const hostTruncated = !output.text.endsWith(delivered);
  return {
    native_chars: native, visible_chars: visible,
    removed_chars: hostTruncated ? 0 : Math.max(0, native - visible),
    host_truncated: hostTruncated,
  };
}

export async function auditTrial(root, planned, protocol) {
  const row = {
    ...planned, reward: null, measurement_issues: [], outputs: [], wrapped_commands: 0,
    shell_commands: 0, jev_requests: 0, jev_input_tokens: 0, jev_usage_complete: true,
    pruned_outputs: 0, archive_recovery_calls: 0, evidence_isolated: false,
    model_usage_valid: false, incomplete_captures: [],
  };
  const job = join(root, 'jobs', planned.job_name);
  const trials = (await exists(job)).filter(name => name.startsWith(`${planned.task}__`));
  if (trials.length !== 1) {
    row.measurement_issues.push(`Expected one trial; found ${trials.length}`);
    row.measurement_valid = false;
    return row;
  }
  const trial = join(job, trials[0]);
  const agent = join(trial, 'agent');
  const observer = join(agent, 'observer');
  const records = [];
  const evidenceFiles = await exists(observer);
  row.observer_available = (await exists(agent)).includes('observer');
  row.jev_usage_complete = row.observer_available;
  for (const name of evidenceFiles) {
    if (!name.endsWith('.json')) continue;
    try {
      const record = await json(join(observer, name));
      assert.equal(record.marker, 'JEV_EVAL_PRIVATE_EVIDENCE_V1');
      if (name.includes('-jev-')) {
        row.jev_requests++;
        assertNoEvidenceLeak(JSON.stringify(record.request), privatePaths);
        let usage;
        try { usage = JSON.parse(record.response?.body).usage; } catch { /* Retain incomplete responses. */ }
        if (record.response?.status === 200 && Number.isInteger(usage?.input_tokens) && usage.input_tokens >= 0) {
          row.jev_input_tokens += usage.input_tokens;
        } else row.jev_usage_complete = false;
      } else records.push(record);
    } catch (error) {
      row.measurement_issues.push(`Observer ${name}: ${error.message}`);
      row.jev_usage_complete = false;
    }
  }
  const completed = new Set(records.map(record => record.id));
  row.incomplete_captures = [...new Set(evidenceFiles
    .filter(name => /\.(?:raw|delivered)$/.test(name))
    .map(name => name.replace(/\.(?:raw|delivered)$/, '')))]
    .filter(id => !completed.has(id));
  if (row.incomplete_captures.length) {
    row.measurement_issues.push(`Incomplete command captures: ${row.incomplete_captures.length}`);
    if (planned.arm === 'plugin') row.jev_usage_complete = false;
  }
  try {
    const result = await json(join(trial, 'result.json'));
    row.reward = result.verifier_result?.rewards?.reward ?? null;
    row.exception = result.exception_info;
    row.verifier = result.verifier_result;
    row.agent_seconds = result.agent_execution?.finished_at
      ? (Date.parse(result.agent_execution.finished_at) - Date.parse(result.agent_execution.started_at)) / 1000 : null;
    row.wall_seconds = result.finished_at
      ? (Date.parse(result.finished_at) - Date.parse(result.started_at)) / 1000 : null;
    assert.equal(result.task_id.git_commit_id, protocol.benchmark_commit, 'Dataset revision mismatch');
    const settings = await json(join(agent, 'eval-settings.json'));
    assert.equal(settings.arm, planned.arm);
    assert.equal(settings.instructions, protocol.instructions);
    const stream = events(await readFile(join(agent, 'codex.txt'), 'utf8'));
    row.agent_errors = stream.filter(event => ['error', 'turn.failed'].includes(event.type));
    const turns = stream.filter(event => event.type === 'turn.completed');
    assert.equal(turns.length, 1, 'Expected one complete Codex turn');
    row.usage = turns[0].usage;
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      assert(Number.isInteger(row.usage[key]) && row.usage[key] >= 0, `Invalid ${key}`);
    }
    assert(row.usage.cached_input_tokens <= row.usage.input_tokens);
    const sessionsRoot = join(agent, 'sessions');
    const sessions = (await readdir(sessionsRoot, { recursive: true })).filter(name => name.endsWith('.jsonl'));
    assert.equal(sessions.length, 1, 'Expected exactly one native session (no delegation)');
    const transcriptText = await readFile(join(sessionsRoot, sessions[0]), 'utf8');
    const transcript = events(transcriptText);
    const contexts = transcript.filter(event => event.type === 'turn_context');
    assert(contexts.length > 0 && contexts.every(event => event.payload.model === 'gpt-5.5'), 'Model mismatch');
    const total = transcript.filter(event => event.type === 'event_msg' &&
      event.payload.type === 'token_count' && event.payload.info).at(-1)?.payload.info.total_token_usage;
    assert(total, 'Missing native usage');
    assert.equal(total.input_tokens, row.usage.input_tokens, 'Native/CLI input mismatch');
    assert.equal(total.cached_input_tokens, row.usage.cached_input_tokens, 'Native/CLI cache mismatch');
    assert.equal(total.output_tokens, row.usage.output_tokens, 'Native/CLI output mismatch');
    row.reasoning_output_tokens = total.reasoning_output_tokens ?? null;
    row.model_usage_valid = true;
    const visible = JSON.stringify(payloads(transcript));
    assertNoEvidenceLeak(visible, privatePaths);
    row.evidence_isolated = true;
    const groups = toolGroups(transcript);
    row.wrapper_tool_calls = groups.length;
    row.wrapped_commands = records.length;
    row.shell_commands = payloads(transcript).filter(item =>
      item.type === 'function_call' && /(?:exec_command|shell_command|shell)$/.test(item.name)).length;
    records.sort((left, right) => left.started - right.started);
    const credited = new Set();
    for (const record of records) {
      assert.equal(record.child_code, record.wrapper_code, 'Exit status mismatch');
      const raw = await readFile(join(observer, `${record.id}.raw`), 'utf8');
      const delivered = await readFile(join(observer, `${record.id}.delivered`), 'utf8');
      const wrapperPruned = Boolean(record.archive) && delivered.length < raw.length;
      if (wrapperPruned) assert.equal(record.archive_exact, true, 'Archive mismatch');
      else assert.equal(raw, delivered, 'Unexplained output modification');
      if (planned.arm === 'control') assert.equal(wrapperPruned, false, 'Control output pruned');
      let reduction = { native_chars: null, visible_chars: null, removed_chars: 0 };
      if (wrapperPruned) {
        const matches = groups.filter(group =>
          group.outputs.some(output => output.text.includes(record.archive)));
        assert.equal(matches.length, 1, 'Expected one native group containing the archive footer');
        const [group] = matches;
        assert(!credited.has(group), 'Multiple pruned captures share one native group; savings not attributable');
        credited.add(group);
        reduction = visibleReduction(raw, delivered, group);
      }
      const actual = wrapperPruned && reduction.removed_chars > 0;
      row.pruned_outputs += Number(actual);
      if (record.archive) row.archive_recovery_calls += payloads(transcript).filter(item =>
        item.type === 'function_call' && item.arguments.includes(record.archive)).length;
      row.outputs.push({
        id: record.id, command: record.command, raw_chars: raw.length,
        delivered_chars: delivered.length, wrapper_pruned: wrapperPruned,
        actual_pruning: actual, ...reduction,
      });
    }
    if (!row.jev_usage_complete) row.measurement_issues.push('Incomplete Jev usage');
    if (planned.arm === 'control' && row.jev_requests !== 0) row.measurement_issues.push('Control made Jev requests');
  } catch (error) {
    row.measurement_issues.push(error.message);
  }
  row.jev_estimated_usd = row.jev_usage_complete ? row.jev_input_tokens * 0.042 / 1e6 : null;
  if (row.model_usage_valid) {
    row.model_normalized_cost_usd = (row.usage.input_tokens * 5 + row.usage.output_tokens * 30) / 1e6;
  }
  if (row.model_usage_valid && row.jev_estimated_usd !== null) {
    row.normalized_cost_usd = row.model_normalized_cost_usd + row.jev_estimated_usd;
    row.observed_cache_cost_usd = row.normalized_cost_usd - row.usage.cached_input_tokens * 4.5 / 1e6;
  }
  row.measurement_valid = row.measurement_issues.length === 0;
  return row;
}

export function summarize(rows) {
  const aggregate = group => ({
    planned: group.length, finished: group.filter(row => row.state === 'finished').length,
    states: Object.fromEntries([...new Set(group.map(row => row.state))]
      .map(state => [state, group.filter(row => row.state === state).length])),
    rewards_available: group.filter(row => row.reward !== null).length,
    passed: group.filter(row => row.reward === 1).length,
    failed: group.filter(row => row.reward === 0).length,
    valid_measurements: group.filter(row => row.measurement_valid).length,
    valid_model_usage: group.filter(row => row.model_usage_valid).length,
    cost_available: group.filter(row => row.normalized_cost_usd !== undefined).length,
    model_normalized_cost_usd_known: group.reduce((sum, row) => sum + (row.model_normalized_cost_usd ?? 0), 0),
    normalized_cost_usd_lower_bound: group.reduce((sum, row) =>
      sum + (row.model_normalized_cost_usd ?? 0) + row.jev_input_tokens * 0.042 / 1e6, 0),
    normalized_cost_usd_known: group.reduce((sum, row) => sum + (row.normalized_cost_usd ?? 0), 0),
    observed_cache_cost_usd_known: group.reduce((sum, row) => sum + (row.observed_cache_cost_usd ?? 0), 0),
    input_tokens_known: group.reduce((sum, row) => sum + (row.usage?.input_tokens ?? 0), 0),
    cached_input_tokens_known: group.reduce((sum, row) => sum + (row.usage?.cached_input_tokens ?? 0), 0),
    output_tokens_known: group.reduce((sum, row) => sum + (row.usage?.output_tokens ?? 0), 0),
    reasoning_output_tokens_known: group.reduce((sum, row) => sum + (row.reasoning_output_tokens ?? 0), 0),
    jev_requests: group.reduce((sum, row) => sum + row.jev_requests, 0),
    jev_input_tokens_known: group.reduce((sum, row) => sum + row.jev_input_tokens, 0),
    trials_with_actual_pruning: group.filter(row => row.measurement_valid && row.pruned_outputs > 0).length,
    completed_wrapped_commands: group.reduce((sum, row) => sum + (row.wrapped_commands ?? 0), 0),
    agent_seconds_known: group.reduce((sum, row) => sum + (row.agent_seconds ?? 0), 0),
    wall_seconds_known: group.reduce((sum, row) => sum + (row.wall_seconds ?? 0), 0),
    recovery_calls: group.reduce((sum, row) => sum + row.archive_recovery_calls, 0),
  });
  const tasks = [...new Set(rows.map(row => row.task))];
  const qualifying = tasks.filter(task => {
    const pair = rows.filter(row => row.task === task);
    return pair.length === 2 && pair.every(row => row.measurement_valid) &&
      pair.some(row => row.arm === 'plugin' && row.pruned_outputs > 0);
  });
  return {
    overall: Object.fromEntries(['control', 'plugin'].map(arm => [arm, aggregate(rows.filter(row => row.arm === arm))])),
    qualifying_tasks: qualifying,
    effectiveness: Object.fromEntries(['control', 'plugin'].map(arm => [
      arm, qualifying.length ? aggregate(rows.filter(row => row.arm === arm && qualifying.includes(row.task))) : null,
    ])),
    trials: rows,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2]);
  const protocol = await json(join(root, 'protocol.json'));
  const rows = await json(join(root, 'progress.json'));
  const audited = [];
  for (const row of rows) audited.push(await auditTrial(root, row, protocol));
  const summary = summarize(audited);
  await writeFile(join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ overall: summary.overall, qualifying_tasks: summary.qualifying_tasks }, null, 2));
}
