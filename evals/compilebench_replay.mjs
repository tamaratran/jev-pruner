import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneCodexOutput } from '../dist/codex/prune.js';
import { saveContext } from '../dist/codex/context.js';
import { buildJevRequest, parseJevResponse } from '../dist/jev.js';
import { isProtectedLine } from '../dist/retention.js';
import { hostPreviews } from './codex-preview.mjs';
import { assertNoEvidenceLeak } from './observer/evidence-isolation.mjs';

assert(process.argv[2] && process.argv[3],
  'Usage: node evals/compilebench_replay.mjs <capture-pilot> <fresh-evidence>');
assert(process.env.TYPESAFE_API_KEY, 'TYPESAFE_API_KEY required');
const [pilot, root] = process.argv.slice(2).map(path => resolve(path));
const repo = fileURLToPath(new URL('../', import.meta.url));
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const audit = await load(join(pilot, 'capture-audit.json'));
const selected = audit.rows.flatMap(row => row.family === 'compile'
  ? row.raw.filter(raw => raw.stdout.candidate).map(raw => ({ trial: row.trial, task: row.task, raw }))
  : []);
assert.equal(selected.length, 4, 'Expected the four reviewed build-log candidates');
const sourceFiles = ['evals/compilebench_replay.mjs',
  ...(await readdir(join(repo, 'dist'), { recursive: true }))
    .filter(name => name.endsWith('.js')).map(name => `dist/${name}`)];
const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async name =>
  [name, hash(await readFile(join(repo, name)))])));
await mkdir(root, { mode: 0o700 });
await save(join(root, 'protocol.json'), {
  created_at: new Date().toISOString(), selected,
  capture_audit_sha256: hash(await readFile(join(pilot, 'capture-audit.json'))),
  source_sha256: sourceHashes,
  scope: 'Saved-output activation and retention replay; no Codex inference or task-quality claim.',
  settings: 'Unchanged production Codex adapter, original command and preceding native context.',
  native_preview: 'Conservative reduction only when delivery fits the saved call budget, capped at 10000.',
});
const results = [];
for (const { trial, task, raw } of selected) {
  const directory = join(root, `${task}-${raw.id}`);
  await mkdir(directory);
  const nativeFiles = audit.rows.find(row => row.task === task).native;
  const sessionFiles = (await readdir(join(trial, 'agent/sessions'), { recursive: true }))
    .filter(name => name.endsWith('.jsonl'));
  assert.equal(sessionFiles.length, 1);
  const events = (await readFile(join(trial, 'agent/sessions', sessionFiles[0]), 'utf8'))
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
  const callIndex = events.findLastIndex(event => {
    if (event.type !== 'response_item' || event.payload.type !== 'function_call' ||
        Date.parse(event.timestamp) > raw.started) return false;
    const args = JSON.parse(event.payload.arguments);
    const executable = (args.cmd ?? args.command ?? '')
      .match(/\/opt\/jev-eval\/evals\/capture_command\.mjs\s+--\s+(\S+)/)?.[1];
    return executable === raw.command[0] && args.workdir === raw.cwd;
  });
  assert(callIndex >= 0);
  assert(raw.started - Date.parse(events[callIndex].timestamp) < 5000,
    'No recent matching wrapper invocation');
  const call = events[callIndex].payload;
  const args = JSON.parse(call.arguments);
  assert(nativeFiles.shell.some(item => item.call_id === call.call_id));
  const context = events.slice(0, callIndex + 1).map(event => JSON.stringify(event)).join('\n');
  const transcript = join(directory, 'preceding-context.jsonl');
  await writeFile(transcript, context, { mode: 0o600 });
  await saveContext({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: raw.thread,
    transcript_path: transcript,
  }, directory);
  const input = await readFile(join(trial, 'agent/observer', `${raw.id}.stdout`));
  const stderr = await readFile(join(trial, 'agent/observer', `${raw.id}.stderr`));
  assert.equal(hash(input), raw.stdout_sha256);
  assert.equal(hash(stderr), raw.stderr_sha256);
  await writeFile(join(directory, 'raw.stdout'), input);
  await writeFile(join(directory, 'raw.stderr'), stderr);
  const captures = [];
  const started = Date.now();
  const output = await pruneCodexOutput(input, raw.command.join(' '), {
    cwd: directory, home: directory, exitCode: raw.code, sessionId: raw.thread,
    apiKey: process.env.TYPESAFE_API_KEY,
    asker: {
      async ask(state, questions) {
        const request = buildJevRequest({ apiKey: process.env.TYPESAFE_API_KEY }, state, questions);
        const capture = { request: JSON.parse(request.body), started: Date.now() };
        assertNoEvidenceLeak(JSON.stringify(capture.request),
          ['/opt/jev-eval/evidence', '/opt/jev-eval/private']);
        captures.push(capture);
        const path = join(directory, `request-${captures.length}.json`);
        await save(path, capture);
        try {
          const response = await fetch(request.url, {
            method: request.method, headers: request.headers, body: request.body,
            signal: AbortSignal.timeout(30000),
          });
          const body = await response.text();
          capture.response = { status: response.status, body };
          return parseJevResponse(response.status, response.ok, body);
        } catch (error) {
          capture.error = String(error);
          throw error;
        } finally {
          capture.duration_ms = Date.now() - capture.started;
          await save(path, capture);
        }
      },
    },
  });
  await writeFile(join(directory, 'delivered.stdout'), output);
  const original = input.toString();
  const delivered = output.toString();
  const lines = original.split('\n').filter(line => line.trim());
  const required = lines.filter(isProtectedLine).concat(lines[0], lines.at(-1));
  const missing = required.filter(line => !delivered.includes(line));
  const budget = Math.min(args.max_output_tokens ?? 10000, 10000);
  const baselineChars = Math.min(...hostPreviews(original, budget).map(text => text.length));
  const deliveryFits = hostPreviews(delivered, budget).every(text => text === delivered);
  const usageComplete = captures.every(capture => capture.response?.status === 200 &&
    Number.isInteger(JSON.parse(capture.response.body).usage?.input_tokens));
  const tokens = usageComplete
    ? captures.reduce((sum, capture) => sum + JSON.parse(capture.response.body).usage.input_tokens, 0)
    : null;
  const result = {
    task, id: raw.id, command: raw.command, saved_call_id: call.call_id,
    saved_budget: args.max_output_tokens ?? 10000, evaluated_budget: budget,
    source_sha256: hash(input), preceding_context_sha256: hash(context),
    raw_chars: original.length, delivered_chars: delivered.length,
    wrapper_pruned: !input.equals(output), delivery_fits_native_preview: deliveryFits,
    conservative_visible_removed_chars: deliveryFits ? Math.max(0, baselineChars - delivered.length) : 0,
    protected_and_boundary_lines: required.length, missing_required_lines: missing,
    stderr_sha256: hash(stderr), exit_code: raw.code,
    requests: captures.length, usage_complete: usageComplete, jev_input_tokens: tokens,
    jev_estimated_usd: tokens === null ? null : tokens * 0.042 / 1e6,
    seconds: (Date.now() - started) / 1000,
  };
  results.push(result);
  await save(join(root, 'results.json'), results);
  console.log(JSON.stringify(result));
  assert.equal(missing.length, 0, 'Required output removed');
  assert(usageComplete, 'Incomplete Jev scoring or usage');
}
await save(join(root, 'gate.json'), {
  passed: results.some(row => row.conservative_visible_removed_chars > 0) &&
    results.every(row => row.usage_complete && row.missing_required_lines.length === 0),
  replayed: results.length,
  note: 'Necessary activation check; manual review of removed content is still required.',
});
