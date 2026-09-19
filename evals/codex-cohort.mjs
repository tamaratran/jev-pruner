import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contextPath } from '../dist/codex/context.js';
import { commandOutput } from '../tests/fixtures/codex-transcript.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.argv[2] ?? '');
assert(process.argv[2], 'Usage: node evals/codex-cohort.mjs <new-evidence-directory>');
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY for this live evaluation.');
const plugin = process.env.JEV_CODEX_PLUGIN_ROOT ??
  join(homedir(), '.codex/plugins/cache/jev-pruner-codex/jev-pruner/0.1.0');
const wrapper = join(plugin, 'dist/codex/run.js');
const producer = join(repo, 'tests/fixtures/codex-noisy-build.mjs');
const observer = join(repo, 'tests/fixtures/codex-observer.mjs');
const model = 'gpt-5.5';
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const rows = [];

async function execute(command, args, cwd, timeout = 180_000) {
  const child = spawn(command, args, { cwd, env: process.env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  child.stdin.end();
  let timedOut = false;
  const started = Date.now();
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
  const force = setTimeout(() => child.kill('SIGKILL'), timeout + 10_000);
  try {
    const code = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    return {
      code, timedOut, seconds: (Date.now() - started) / 1000,
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
}

await mkdir(root, { mode: 0o700 });
const files = [
  'evals/codex-cohort.mjs', 'tests/fixtures/codex-noisy-build.mjs',
  'tests/fixtures/codex-observer.mjs', 'tests/fixtures/codex-transcript.mjs',
  ...(await readdir(join(repo, 'dist'), { recursive: true }))
    .filter(path => path.endsWith('.js')).map(path => `dist/${path}`),
];
const hashes = {};
for (const file of files) {
  hashes[file] = hash(await readFile(join(repo, file)));
  if (file.startsWith('dist/')) assert.equal(hash(await readFile(join(plugin, file))), hashes[file]);
}
const revision = (await execute('git', ['rev-parse', 'HEAD'], repo)).stdout.trim();
const version = (await execute('codex', ['--version'], repo)).stdout.trim();
assert.equal(version, 'codex-cli 0.152.1');
const login = await execute('codex', ['login', 'status'], repo);
assert.match(login.stdout + login.stderr, /Logged in using ChatGPT/);
const pairs = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1, stage: index + 10,
  target: index % 2 ? 'P9' : 'Q7',
  arms: index % 2 ? ['pruned', 'native'] : ['native', 'pruned'],
}));
await save('protocol.json', {
  created: new Date().toISOString(), revision, version, model, hashes, pairs,
  scope: 'Six pairs on one constructed log-reading workload, selected after a successful preflight. Not a general coding benchmark.',
  controls: 'Fresh sessions, matched fixture per pair, alternating arm order, low reasoning, 30000-token tool budget. Shared subscription prompt caching is uncontrolled.',
  inclusion: 'Include both arms only when the pruned arm actually prunes and both arms have audited model-visible output and complete usage. Never filter on answer correctness.',
  recovery: 'Archive reads allowed; fixture source reads prohibited in both arms.',
  prices: {
    model_per_million: { input: 5, cached_input: 0.5, output: 30 },
    model_source: 'https://developers.openai.com/api/docs/models/gpt-5.5',
    jev_input_per_million: 0.042,
    jev_source: 'https://openrouter.ai/typesafe/jev-1.13',
    caveat: 'API-equivalent estimates, not ChatGPT subscription charges. Jev uses the published reference rate, not an invoice.',
  },
});
console.log(`Frozen protocol: ${root}`);

async function trial(pair, arm) {
  const name = `${pair.id}-${arm}`;
  const cwd = join(root, name);
  await mkdir(cwd, { mode: 0o700 });
  for (const [file, expected] of Object.entries(hashes)) {
    assert.equal(hash(await readFile(join(repo, file))), expected, `Source changed: ${file}`);
  }
  const original = await execute('node', [producer, String(pair.stage)], cwd);
  assert.equal(original.code, 0);
  await writeFile(join(cwd, 'original.txt'), original.stdout, { mode: 0o600 });
  const command = `${arm === 'pruned' ? `node --import ${quote(observer)} ${quote(wrapper)} -- ` : ''}node ${quote(producer)} ${pair.stage}`;
  const prompt = `Read this build log using exactly this command, requesting at least 30000 output tokens:
${command}
Report the ${pair.target} release bundle, stable-snapshot rollback, and deployment blocker. Return JSON with artifact, rollback, blocker.
Use the command exactly as written without adding or removing wrappers or arguments. You may read an archive if required facts are missing, but do not read fixture source. Cache-entry progress is unrelated to this question.`;
  await writeFile(join(cwd, 'prompt.txt'), prompt, { mode: 0o600 });
  const result = await execute('codex', [
    'exec', '--model', model, '--sandbox', 'workspace-write',
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'tool_output_token_limit=30000',
    '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json', prompt,
  ], cwd);
  await save(`${name}/execution.json`, result);
  const row = { pair: pair.id, arm, stage: pair.stage, target: pair.target, seconds: result.seconds };
  try {
    assert.equal(result.timedOut, false, 'Codex timed out');
    assert.equal(result.code, 0, 'Codex failed');
    const events = result.stdout.split('\n').filter(Boolean).map(JSON.parse);
    assert(!events.some(event => ['turn.failed', 'error'].includes(event.type)), 'Failed turn');
    row.usage = events.find(event => event.type === 'turn.completed')?.usage;
    assert(row.usage, 'No usage');
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      assert(Number.isFinite(row.usage[key]) && row.usage[key] >= 0, `Invalid ${key}`);
    }
    assert(row.usage.cached_input_tokens <= row.usage.input_tokens);
    assert.equal(row.usage.cache_write_input_tokens ?? 0, 0, 'Unexpected cache writes');
    row.model_estimated_usd = (
      (row.usage.input_tokens - row.usage.cached_input_tokens) * 5 +
      row.usage.cached_input_tokens * 0.5 + row.usage.output_tokens * 30
    ) / 1_000_000;
    const session = events.find(event => event.type === 'thread.started')?.thread_id;
    assert(session, 'No session');
    const pointer = JSON.parse(await readFile(contextPath(session), 'utf8'));
    const transcript = (await readFile(pointer.transcript, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    await save(`${name}/responses.json`, transcript.filter(entry => entry.type === 'response_item'));
    assert(transcript.some(entry => entry.type === 'turn_context' && entry.payload.model === model));
    const outputs = transcript.filter(entry => entry.type === 'response_item' &&
      /^(function_call_output|custom_tool_call_output)$/.test(entry.payload.type))
      .map(entry => commandOutput(entry.payload)).filter(text => text?.includes(`progress: stage ${pair.stage}`));
    assert.equal(outputs.length, 1, 'Expected one recorded fixture output');
    const visible = outputs[0];
    await writeFile(join(cwd, 'visible.txt'), visible, { mode: 0o600 });
    assert(!/\d+ (?:tokens|characters) truncated|Warning: truncated output/.test(visible), 'Host truncation');
    row.commands = events.filter(event => event.type === 'item.completed' &&
      event.item.type === 'command_execution').map(event => event.item.command);
    assert.equal(row.commands.filter(cmd => cmd.includes(producer)).length, 1, 'Repeated fixture/source access');
    assert.equal(row.commands.some(cmd => cmd.includes(wrapper)), arm === 'pruned', 'Wrong condition');
    row.pruned = visible.includes('[fast-jev-output trimmed');
    row.original_chars = original.stdout.length + original.stderr.length;
    row.visible_chars = visible.length;
    row.recovery_commands = row.commands.filter(cmd => cmd.includes('.jev-pruner/')).length;
    const stdout = visible.replace(original.stderr, '');
    if (row.pruned) {
      assert.equal(arm, 'pruned');
      assert(visible.length < row.original_chars);
      const archive = visible.match(/\[fast-jev-output full output: (.*?) \(Read or grep it if needed\)\]/)?.[1];
      assert(archive, 'Missing recovery footer');
      row.archive_exact = (await readFile(archive, 'utf8')) === original.stdout;
      const lines = new Set(original.stdout.split('\n'));
      row.retained_lines_verbatim = stdout.split('\n').every(line =>
        !line || line.startsWith('[fast-jev-output') || lines.has(line));
    } else {
      assert.equal(stdout, original.stdout, 'Unpruned output differs');
    }
    const artifact = `release-${pair.target}-stage${pair.stage}-${pair.target === 'Q7' ? '6d81' : '72bc'}.tar.gz`;
    const rollback = `snapshot-stage${pair.stage}-a312`;
    row.required_facts_visible = [artifact, rollback, 'release directory is not writable'].every(fact => visible.includes(fact));
    row.stderr_preserved = visible.includes(original.stderr.trim());
    row.answer = events.findLast(event => event.type === 'item.completed' &&
      event.item.type === 'agent_message')?.item.text ?? '';
    row.facts = [
      row.answer.includes(artifact), row.answer.includes(rollback),
      /release directory (?:is )?not writable/i.test(row.answer),
    ];
    row.factual_pass = row.facts.every(Boolean);
    try {
      const parsed = JSON.parse(row.answer);
      row.format_pass = ['artifact', 'rollback', 'blocker'].every(key => typeof parsed[key] === 'string');
    } catch {
      row.format_pass = false;
    }
    row.audit_pass = true;
  } catch (error) {
    row.audit_pass = false;
    row.error = String(error);
  }
  const captureDir = join(cwd, 'captures');
  const captures = await readdir(captureDir).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  row.jev_requests = captures.length;
  row.jev_statuses = [];
  row.jev_input_tokens = 0;
  row.jev_summed_seconds = 0;
  for (const file of captures) {
    const capture = JSON.parse(await readFile(join(captureDir, file), 'utf8'));
    row.jev_statuses.push(capture.response?.status ?? null);
    row.jev_summed_seconds += capture.durationMs / 1000;
    const usage = capture.response?.body ? JSON.parse(capture.response.body).usage : undefined;
    if (usage && Number.isFinite(usage.input_tokens)) row.jev_input_tokens += usage.input_tokens;
    else row.jev_usage_incomplete = true;
  }
  row.jev_estimated_usd = row.jev_usage_incomplete ? null : row.jev_input_tokens * 0.042 / 1_000_000;
  if (row.pruned && !row.jev_requests) {
    row.audit_pass = false;
    row.error = 'Pruned output without captured Jev requests';
  }
  row.total_estimated_usd = row.model_estimated_usd !== undefined && row.jev_estimated_usd !== null
    ? row.model_estimated_usd + row.jev_estimated_usd : null;
  await save(`${name}/result.json`, row);
  rows.push(row);
  await save('results.json', rows);
  console.log(`${name}: audit=${row.audit_pass} pruned=${row.pruned} accuracy=${row.factual_pass} Jev=${row.jev_requests}`);
}

for (const pair of pairs) for (const arm of pair.arms) await trial(pair, arm);
const qualifying = pairs.filter(pair => {
  const matched = rows.filter(row => row.pair === pair.id);
  return matched.length === 2 && matched.every(row => row.audit_pass) &&
    matched.some(row => row.arm === 'pruned' && row.pruned);
}).map(pair => pair.id);
await save('selection.json', {
  qualifying_pairs: qualifying,
  excluded_pairs: pairs.filter(pair => !qualifying.includes(pair.id)).map(pair => pair.id),
  note: 'Answer correctness and required-fact retention do not affect inclusion.',
});
console.log(`Complete: ${qualifying.length}/${pairs.length} qualifying pairs. Evidence: ${root}`);
