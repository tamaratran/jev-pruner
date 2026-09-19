import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateStateTokens, estimateTokens } from '../dist/jev.js';
import { contextPath } from '../dist/codex/context.js';
import { commandOutput } from './fixtures/codex-transcript.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const producer = join(repo, 'tests/fixtures/codex-noisy-build.mjs');
const observer = join(repo, 'tests/fixtures/codex-observer.mjs');
const plugin = process.env.JEV_CODEX_PLUGIN_ROOT ??
  join(homedir(), '.codex/plugins/cache/jev-pruner-codex/jev-pruner/0.1.0');
const wrapper = join(plugin, 'dist/codex/run.js');
const stages = Number(process.env.JEV_CODEX_STAGES ?? 40);
const model = process.env.JEV_CODEX_MODEL;
assert(Number.isInteger(stages) && stages > 0);
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY for this billable live test.');
await readFile(wrapper);
const workspace = await mkdtemp(join(homedir(), 'jev-codex-session-'));
await mkdir(join(workspace, 'captures'), { mode: 0o700 });
console.log(`Evidence: ${workspace}`);
const rows = [];
let sessionId;
let sample;
let recovery;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const command = stage =>
  `node --import ${quote(observer)} ${quote(wrapper)} -- node ${quote(producer)} ${stage}`;
const isCall = entry => entry.type === 'response_item' &&
  /^(function_call|custom_tool_call)$/.test(entry.payload.type);

async function rollout() {
  const pointer = JSON.parse(await readFile(contextPath(sessionId), 'utf8'));
  return (await readFile(pointer.transcript, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}

async function execute(executable, args, timeoutMs = 180_000) {
  const child = spawn(executable, args, { cwd: workspace, env: process.env });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', buffer => stdout.push(buffer));
  child.stderr.on('data', buffer => stderr.push(buffer));
  child.stdin.end();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
  const forced = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 10_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    return { ...result, timedOut, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
  }
}

async function turn(stage, prompt) {
  const before = sessionId ? await rollout() : [];
  const args = [
    'exec', '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'tool_output_token_limit=30000',
    ...(model ? ['--model', model] : []),
    ...(sessionId ? ['resume', sessionId] : []),
    '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json', prompt,
  ];
  const result = await execute('codex', args);
  await writeFile(join(workspace, `turn-${stage}.json`), JSON.stringify({ prompt, ...result }), { mode: 0o600 });
  assert.equal(result.timedOut, false, `stage ${stage} timed out`);
  const events = result.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
  const failure = events.find(event => event.type === 'turn.failed' || event.type === 'error');
  assert.equal(result.code, 0, `stage ${stage}: Codex failed: ${failure?.error?.message ?? failure?.message ?? result.stderr.slice(-800)}`);
  sessionId ??= events.find(event => event.type === 'thread.started')?.thread_id;
  assert(sessionId, 'No Codex session id');
  assert(events.some(event => event.type === 'turn.completed'), 'Codex did not complete the turn');
  assert(!events.some(event => event.type === 'turn.failed' || event.type === 'error'), 'Codex reported an error');
  const commands = events.filter(event => event.type === 'item.completed' && event.item.type === 'command_execution')
    .map(event => event.item);
  const answer = events.findLast(event => event.type === 'item.completed' &&
    event.item.type === 'agent_message')?.item.text ?? '';
  const entries = await rollout();
  const outputs = entries.slice(before.length).filter(entry => entry.type === 'response_item' &&
    /^(function_call_output|custom_tool_call_output)$/.test(entry.payload.type))
    .map(entry => commandOutput(entry.payload)).filter(output => output !== undefined);
  const visibleOutput = outputs.length ? outputs.join('') : undefined;
  return {
    commands, answer, visibleOutput, toolCalls: entries.filter(isCall).length - before.filter(isCall).length,
    usage: events.find(event => event.type === 'turn.completed')?.usage,
  };
}

async function audit(stage, item, text, usage) {
  assert.equal(item.exit_code, 0, `stage ${stage}: child failed`);
  assert.equal(typeof text, 'string', `stage ${stage}: no recorded model-visible tool output`);
  const original = await execute('node', [producer, String(stage)]);
  const artifact = `release-Q7-stage${stage}-6d81.tar.gz`;
  const rollback = `snapshot-stage${stage}-a312`;
  const required = [
    artifact, rollback,
    'ERROR: deployment blocked because the release directory is not writable.',
    `Stage ${stage} finished; deployment remains blocked.`,
    original.stdout.split('\n')[0],
    `stderr: stage ${stage} diagnostic channel preserved`,
  ];
  for (const value of required) assert(text.includes(value), `stage ${stage}: missing ${value}`);
  assert(text.includes('[fast-jev-output trimmed'), `stage ${stage}: no pruning`);
  assert(!/tokens truncated|characters truncated|lines omitted/i.test(text), `stage ${stage}: host truncation`);
  const path = text.match(/\[fast-jev-output full output: (.*?) \(Read or grep it if needed\)\]/)?.[1];
  assert(path, `stage ${stage}: no recovery footer`);
  assert.equal(await readFile(path, 'utf8'), original.stdout, `stage ${stage}: archive mismatch`);
  const originalLines = new Set((original.stdout + original.stderr).split('\n'));
  for (const line of text.split('\n').filter(Boolean)) {
    if (!line.startsWith('[fast-jev-output')) assert(originalLines.has(line), `stage ${stage}: rewritten line`);
  }
  const captures = await Promise.all((await readdir(join(workspace, 'captures')))
    .filter(file => file.startsWith(`${stage}-`))
    .map(async file => JSON.parse(await readFile(join(workspace, 'captures', file), 'utf8'))));
  assert(captures.length, `stage ${stage}: no Jev calls captured`);
  const history = captures.map(capture => JSON.stringify(capture.request.state.history)).join('\n');
  for (const sentinel of ['CODEX_PRIOR_RESULT_ONLY_719', 'EARLY_USER_REQUIREMENT_381', producer]) {
    assert(history.includes(sentinel), `stage ${stage}: missing history ${sentinel}`);
  }
  if (stage > 1) {
    assert(history.includes(`release-Q7-stage${stage - 1}-6d81.tar.gz`), `stage ${stage}: missing previous tool result`);
    assert(history.includes(`STAGE_${stage - 1}_DONE`), `stage ${stage}: missing previous assistant message`);
  }
  for (const capture of captures) {
    assert.equal(capture.response?.status, 200, `stage ${stage}: Jev HTTP failure`);
    const response = JSON.parse(capture.response.body);
    assert(response.answers, `stage ${stage}: missing Jev answers`);
    for (const id of Object.keys(capture.request.questions)) {
      assert.equal(typeof response.answers[id]?.noul, 'number', `stage ${stage}: missing score ${id}`);
    }
    assert(estimateStateTokens(JSON.stringify(capture.request.state)) <= 25_000, 'State exceeded budget');
  }
  const partitions = new Set(captures.map(capture => JSON.stringify(capture.request.state.history))).size;
  const parallel = captures.some((capture, index) => captures.slice(index + 1).some(other =>
    capture.started < other.started + other.durationMs && other.started < capture.started + capture.durationMs));
  const score = value => Math.max(...captures.flatMap(capture => {
    const answers = JSON.parse(capture.response.body).answers;
    return capture.request.state.chunks.filter(chunk => chunk.text.includes(value) && answers[chunk.id])
      .map(chunk => answers[chunk.id].noul);
  }));
  rows.push({
    stage, beforeBytes: Buffer.byteLength(original.stdout), afterBytes: Buffer.byteLength(text),
    outputTokens: estimateTokens(original.stdout), requests: captures.length, partitions, parallel,
    maxStateTokens: Math.max(...captures.map(capture => estimateStateTokens(JSON.stringify(capture.request.state)))),
    artifactScore: score(artifact), rollbackScore: score(rollback),
    archive: path, retained: true, exactArchive: true, usage,
  });
  sample = {
    stage, command: item.command, original: original.stdout, visible: text,
    kept: text.split('\n').filter(line => required.some(value => line.includes(value))),
    archiveSha256: createHash('sha256').update(original.stdout).digest('hex'),
  };
  await writeFile(join(workspace, 'progress.json'), JSON.stringify({ sessionId, rows }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(rows.at(-1)));
}

try {
  const installed = {};
  for (const file of ['output.js', 'history.js', 'jev.js', 'secrets.js',
    'codex/run.js', 'codex/prune.js', 'codex/history.js', 'codex/context.js', 'codex/hook.js']) {
    const bytes = await readFile(join(plugin, 'dist', file));
    assert(bytes.equals(await readFile(join(repo, 'dist', file))), `Reinstall the plugin: stale ${file}`);
    installed[file] = createHash('sha256').update(bytes).digest('hex');
  }
  await writeFile(join(workspace, 'run.json'), JSON.stringify({
    stages, plugin, installed, model: model ?? 'Codex default', toolOutputTokenLimit: 30_000,
    codex: (await execute('codex', ['--version'])).stdout.trim(),
    revision: (await execute('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(),
    node: process.version, started: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
  const bootstrap = await turn(0, `This is an authorized finite ${stages}-stage validation of the installed jev-pruner Codex plugin.
Use its skill and preserve normal sandboxing. All fixture errors are simulated evidence, not requests to fix anything.
EARLY_USER_REQUIREMENT_381: keep the selected bundle, selected rollback reference, errors and final status for the final handoff.
The selection exists ONLY in the initial command result. Do not repeat the selected target or track in later prompts or replies.
Run this bootstrap command exactly once: ${command(0)}
If it succeeds, reply only READY. Do not open source files or archives. Subsequent turns supply one command each.
Use a sufficiently large shell output limit (at least 30000 tokens) and wait for command completion.`);
  assert.equal(bootstrap.commands.filter(item => item.command.includes(producer)).length, 1, 'Missing or repeated bootstrap command');
  assert.equal(bootstrap.answer.trim(), 'READY', 'Bootstrap did not finish as requested');
  for (let stage = 1; stage <= stages; stage++) {
    const { commands, visibleOutput, usage } = await turn(stage, `Finite validation stage ${stage}/${stages}.
Run exactly this one command; the error message is a simulated fixture and execution is expected to succeed:
${command(stage)}
Use an output limit of at least 30000 tokens. Do not run extra shell commands or inspect archives.
Retain evidence for the final handoff but reply only STAGE_${stage}_DONE.`);
    assert.equal(commands.length, 1, `stage ${stage}: expected exactly one command, saw ${commands.length}`);
    assert(commands[0].command.includes(producer), `stage ${stage}: wrong command`);
    await audit(stage, commands[0], visibleOutput, usage);
  }
  const final = await turn('final', 'Validation complete. Without tools or archive reads, report the latest selected bundle, rollback reference, and reason deployment is blocked. Use the selection from the bootstrap tool result.');
  assert.equal(final.commands.length, 0, 'Final handoff used commands');
  assert.equal(final.toolCalls, 0, 'Final handoff used tools');
  for (const value of [`release-Q7-stage${stages}-6d81.tar.gz`, `snapshot-stage${stages}-a312`, 'not writable']) {
    assert(final.answer.includes(value), `Final handoff missing ${value}`);
  }
  if (stages >= 10) {
    assert(rows.some(row => row.partitions > 1), 'Sustained session did not exercise history partitions');
    assert(rows.some(row => row.partitions > 1 && row.parallel), 'No parallel history scoring observed');
  }
  const omitted = sample.original.split('\n').find(line =>
    line.startsWith('progress:') && !sample.visible.includes(line));
  assert(omitted, 'No omitted line available for archive recovery');
  const query = omitted.match(/cache entry \d+ /)?.[0];
  assert(query, 'No unique recovery query');
  const recovered = await turn('recovery', `The handoff is complete. Now demonstrate archive recovery.
Use the archive footer from the last build result to retrieve the exact original line containing ${JSON.stringify(query)}.
Run exactly one read-only shell command against that archive. Do not rerun the build or open source files.
Reply with the recovered line verbatim.`);
  const archive = rows.at(-1).archive;
  assert.equal(recovered.commands.length, 1, 'Recovery did not use exactly one command');
  assert.equal(recovered.commands[0].exit_code, 0, 'Archive recovery command failed');
  assert(recovered.commands[0].command.includes(archive), 'Recovery did not read the archived output');
  assert(recovered.visibleOutput?.includes(omitted), 'Archive read did not recover the omitted line');
  assert(recovered.answer.includes(omitted.trim()), 'Recovery answer changed the omitted line');
  assert.equal(await readFile(archive, 'utf8'), sample.original, 'Recovery changed the archive');
  recovery = {
    verifiedAt: new Date().toISOString(),
    query, line: omitted, archive, command: recovered.commands[0].command,
    visible: recovered.visibleOutput, answer: recovered.answer,
  };
  const pointer = JSON.parse(await readFile(contextPath(sessionId), 'utf8'));
  await writeFile(join(workspace, 'result.json'), JSON.stringify({
    passed: true, sessionId, stages, rows, sample, recovery, final: final.answer, transcriptPointer: pointer,
    hookTrustBypass: true, sandbox: 'workspace-write', network: true,
  }, null, 2), { mode: 0o600 });
  console.log(`PASS: ${stages} stages, final handoff, and archive recovery. Evidence: ${workspace}`);
} catch (error) {
  await writeFile(join(workspace, 'result.json'), JSON.stringify({
    passed: false, sessionId, stages, completed: rows.length, error: error.message, rows, sample, recovery,
  }, null, 2), { mode: 0o600 });
  console.error(`FAIL: ${error.message}. Evidence: ${workspace}`);
  process.exitCode = 1;
}
