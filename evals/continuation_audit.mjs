import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { checkpointRequest, commonCheckpointHash } from './codex_checkpoint.mjs';
import { fingerprint } from './codex_start.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });

export function responseEvents(body) {
  const events = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') continue;
    try { events.push(JSON.parse(data)); } catch {}
  }
  return events;
}

export function usageFrom(events) {
  const complete = events.filter(event => event.type === 'response.completed');
  assert(complete.length <= 1, 'More than one completion in one forwarded response');
  if (complete.length === 0) return null;
  const usage = complete[0].response.usage;
  for (const key of ['input_tokens', 'output_tokens']) {
    assert(Number.isSafeInteger(usage?.[key]) && usage[key] >= 0, `Invalid ${key}`);
  }
  return {
    input: usage.input_tokens, output: usage.output_tokens,
    cached: usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

async function* records(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line);
}

export async function auditAttempt(root, attempt, checkpoint, reference) {
  const directory = join(root, attempt.id);
  const result = await json(join(directory, 'result.json'));
  const row = {
    id: attempt.id, block: attempt.block, group: attempt.group, condition: attempt.condition,
    status: result.status, reward: result.reward ?? null, matched_start: null,
    forwarded: 0, completed: 0, input: 0, output: 0, cached: 0,
    costs_complete: false, tool_calls: 0, exec_calls: 0, polls: 0, patch_calls: 0,
    captured_outputs: 0, changed_later_outputs: 0, wrapper_failures: 0, jev_requests: 0,
    first_delay_ms: null, issues: [], commands: [],
  };
  if (result.status.startsWith('blocked')) return { row, timeline: [] };
  const timeline = [];
  try {
    const runtime = await json(join(directory, 'private/runtime.json'));
    assert.equal(fingerprint(runtime), fingerprint(reference), 'Runtime differs');
    const expected = checkpointRequest(checkpoint, attempt.condition).input;
    const numbers = new Set();
    const toolResults = new Set();
    let first = true;
    for await (const record of records(join(directory, 'private/requests.jsonl'))) {
      if (record.type === 'request') {
        assert.deepEqual(record.request.input.slice(0, expected.length), expected, 'Replay prefix differs');
        if (first) {
          assert.equal(record.request.input.length, expected.length, 'First request has extra history');
          const masked = structuredClone(record.request);
          masked.input[checkpoint.target].output = '<intervention>';
          assert.equal(fingerprint(masked), commonCheckpointHash(checkpoint, attempt.condition));
          first = false;
          row.matched_start = true;
        }
        const suffix = record.request.input.slice(expected.length);
        for (const item of suffix) {
          if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
          if (!toolResults.has(item.call_id)) {
            toolResults.add(item.call_id);
            timeline.push({ request: record.number, type: 'tool_result',
              call_id: item.call_id, output: item.output });
          }
          if (JSON.stringify(item.output).includes('JEV_EVAL_PRIVATE_EVIDENCE_V1')) {
            row.issues.push('private_evidence_marker_visible');
          }
        }
      }
      if (record.type === 'forward') {
        row.forwarded++;
        if (record.number === 1) row.first_delay_ms = record.actual_delay_ms;
      }
      if (record.type === 'rejected') row.issues.push(record.error);
      if (record.type === 'transport_error') row.issues.push('transport_error');
      if (record.type !== 'response') continue;
      assert(!numbers.has(record.number), 'Duplicate response accounting');
      numbers.add(record.number);
      const events = responseEvents(record.body);
      const usage = usageFrom(events);
      if (usage) {
        row.completed++;
        row.input += usage.input;
        row.output += usage.output;
        row.cached += usage.cached;
      }
      if (record.status !== 200) row.issues.push(`http_${record.status}`);
      for (const event of events) {
        if (event.type !== 'response.output_item.done') continue;
        const item = event.item;
        if (item.type === 'message') {
          timeline.push({ request: record.number, type: 'commentary',
            text: item.content.filter(part => part.type === 'output_text').map(part => part.text).join('\n') });
        } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
          row.tool_calls++;
          const argumentsValue = item.type === 'function_call' ? JSON.parse(item.arguments) : { patch: item.input };
          timeline.push({ request: record.number, type: 'tool', name: item.name,
            call_id: item.call_id, arguments: argumentsValue });
          if (item.name === 'exec_command') {
            row.exec_calls++;
            row.commands.push({ request: record.number, call_id: item.call_id,
              command: argumentsValue.cmd, workdir: argumentsValue.workdir });
          }
          if (item.name === 'write_stdin') row.polls++;
          if (item.name === 'apply_patch') row.patch_calls++;
        }
      }
    }
    row.costs_complete = row.forwarded === row.completed;
    const observer = join(directory, 'private/observer');
    for (const file of await readdir(observer)) {
      if (!file.endsWith('.json')) continue;
      if (file.includes('-jev-')) { row.jev_requests++; continue; }
      const metadata = await json(join(observer, file));
      const raw = await readFile(join(observer, `${metadata.id}.raw`));
      const delivered = await readFile(join(observer, `${metadata.id}.delivered`));
      row.captured_outputs++;
      if (!raw.equals(delivered)) row.changed_later_outputs++;
      if (metadata.child_code !== metadata.wrapper_code) row.wrapper_failures++;
    }
    assert.equal(row.changed_later_outputs, 0, 'Later output changed');
    assert.equal(row.jev_requests, 0, 'Later scoring occurred');
    const sessions = join(directory, 'private/sessions');
    const paths = (await readdir(sessions, { recursive: true })).filter(path => path.endsWith('.jsonl'));
    assert.equal(paths.length, 1, 'Expected one fresh native session');
    let total;
    for await (const event of records(join(sessions, paths[0]))) {
      if (event.type === 'event_msg' && event.payload.type === 'token_count' && event.payload.info) {
        total = event.payload.info.total_token_usage;
      }
    }
    row.telemetry_matches = total?.input_tokens === row.input && total?.output_tokens === row.output;
    if (!row.telemetry_matches) row.issues.push('native_usage_differs_or_missing');
  } catch (error) {
    row.issues.push(error.message);
    row.audit_error = true;
  }
  row.cost_usd = (row.input * 5 + row.output * 30) / 1_000_000;
  row.issues = [...new Set(row.issues)];
  return { row, timeline };
}

export async function audit(root, output) {
  const protocol = await json(join(root, 'protocol.json'));
  const checkpoint = await json(join(root, 'checkpoint.json'));
  const reference = await json(join(root, 'expected-runtime.json'));
  const rows = [];
  const timelines = {};
  for (const attempt of protocol.attempts) {
    const { row, timeline } = await auditAttempt(root, attempt, checkpoint, reference);
    timelines[attempt.id] = timeline;
    rows.push(row);
  }
  await mkdir(output, { recursive: true, mode: 0o700 });
  await save(join(root, 'review-timelines.json'), timelines);
  await save(join(output, 'accounting.json'), {
    schema: 1, common_sha256: commonCheckpointHash(checkpoint, 'native'),
    protocol_sha256: fingerprint(protocol), rows: rows.map(({ commands, ...row }) => row),
  });
  await save(join(root, 'review-commands.json'), rows.map(row => ({ id: row.id, commands: row.commands })));
  console.log(JSON.stringify(rows.map(({ commands, ...row }) => row), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await audit(...process.argv.slice(2).map(path => resolve(path)));
}
