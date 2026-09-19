import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { contextPath } from '../dist/codex/context.js';
import { estimateTokens } from '../dist/jev.js';
import { commandOutput } from './fixtures/codex-transcript.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const observer = join(repo, 'tests/fixtures/codex-observer.mjs');
const plugin = process.env.JEV_CODEX_PLUGIN_ROOT ??
  join(homedir(), '.codex/plugins/cache/jev-pruner-codex/jev-pruner/0.1.0');
const wrapper = join(plugin, 'dist/codex/run.js');
const model = process.env.JEV_CODEX_MODEL;
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY for this billable live test.');
const installed = {};
for (const file of ['output.js', 'history.js', 'jev.js', 'secrets.js',
  'codex/run.js', 'codex/prune.js', 'codex/history.js', 'codex/context.js', 'codex/hook.js']) {
  const bytes = await readFile(join(plugin, 'dist', file));
  assert(bytes.equals(await readFile(join(repo, 'dist', file))), `Reinstall the plugin: stale ${file}`);
  installed[file] = createHash('sha256').update(bytes).digest('hex');
}

const workspace = await mkdtemp(join(homedir(), 'jev-codex-real-tasks-'));
const started = new Date().toISOString();
console.log(`Evidence: ${workspace}`);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tasks = [
  {
    name: 'binary and structured-output safeguards',
    args: ['-n', 'output|stdout|binary|simpleCommand', 'src', 'tests'],
    evidence: [
      'export function looksBinary(',
      String.raw`if (output.includes('\u0000')) return true;`,
      'const sample = output.slice(0, 4_000);',
      'export function looksStructured(',
      String.raw`git\s+(diff|show)`,
    ],
    expected: {
      binaryFunction: 'looksBinary',
      nulScope: 'entire-output',
      controlSampleChars: 4_000,
      structuredFunction: 'looksStructured',
      protectedGitSubcommands: ['diff', 'show'],
    },
    question: `Investigate how this codebase protects binary and structured command output.
Return a JSON object with binaryFunction (function name), nulScope ("entire-output" or "prefix"),
controlSampleChars (number), structuredFunction (function name), and protectedGitSubcommands
(an alphabetically sorted array of git subcommands protected as whole-document output).`,
  },
  {
    name: 'Codex process and recovery semantics',
    args: ['-n', 'codex|stdout|timeout|archive|directory|signal|spawn|reasoning|127|limit|MiB',
      'src', 'tests', 'README.md'],
    evidence: [
      'const limit = 8 * 1024 * 1024;',
      'process.exitCode = 127;',
      'const timeout = setTimeout(cancel, 30_000);',
      "const directory = join(options.cwd, '.jev-pruner');",
      "if (payload.type === 'reasoning') continue;",
    ],
    expected: {
      bufferBytes: 8 * 1024 * 1024,
      spawnFailureExitCode: 127,
      requestTimeoutMs: 30_000,
      archiveDirectory: '.jev-pruner',
      skippedItemType: 'reasoning',
    },
    question: `Investigate the Codex wrapper's process and recovery behavior. Report its stdout
buffer limit, missing-executable status, Jev request timeout, archive directory, and the
transcript item type intentionally skipped. Return only JSON with bufferBytes (number),
spawnFailureExitCode (number), requestTimeoutMs (number), archiveDirectory (basename),
and skippedItemType (string).`,
  },
  {
    name: 'history partition and request-budget safety',
    args: ['-n', 'request|partition|history|scor|MAX_|omitted|keptIndexes',
      'src', 'tests', 'README.md'],
    evidence: [
      'const DEFAULT_MAX_SCORING_REQUESTS = 40;',
      'await Promise.allSettled(requests.map(',
      'scores[index] = Math.max(scores[index]!, noulAnswer(response.value.answers, chunk.id));',
      'if (scoredSegments[index] === histories.length) omitted.delete(index);',
      'omitted.has(index) ||',
      'keptIndexes.add(index);',
      'const DEFAULT_MAX_STATE_TOKENS = 25_000;',
    ],
    expected: {
      additionalRequests: 40,
      concurrent: true,
      neededSegmentsToKeep: 'one',
      incompleteChunk: 'keep',
      stateTokenBudget: 25_000,
    },
    question: `Investigate the scoring request budget and history-partition safeguards. Report the
additional-request allowance beyond the initial request, concurrency behavior, how votes
across partitions combine, what happens to incompletely scored chunks, and the default
state-token budget. Return only JSON with additionalRequests (number), concurrent (boolean),
neededSegmentsToKeep ("one" or "all"), incompleteChunk ("keep" or "drop"),
and stateTokenBudget (number).`,
  },
];

async function execute(executable, args, options = {}) {
  const started = Date.now();
  const child = spawn(executable, args, {
    cwd: options.cwd ?? workspace,
    env: options.env ?? process.env,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  child.stdin.end();
  const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 240_000);
  const forced = setTimeout(() => child.kill('SIGKILL'), (options.timeoutMs ?? 240_000) + 10_000);
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.on('error', reject);
      child.on('close', (code, signal) => resolveResult({ code, signal }));
    });
    return {
      ...result,
      durationMs: Date.now() - started,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
  }
}

async function transcript(sessionId) {
  const pointer = JSON.parse(await readFile(contextPath(sessionId), 'utf8'));
  return (await readFile(pointer.transcript, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
}

async function codexTurn(project, prompt, variant) {
  const args = [
    'exec', '--sandbox', 'workspace-write',
    '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'tool_output_token_limit=30000',
    ...(model ? ['--model', model] : []),
    '--dangerously-bypass-hook-trust', '--json', prompt,
  ];
  const result = await execute('codex', args, { cwd: project });
  await writeFile(join(project, `${variant}-turn.json`), JSON.stringify({ prompt, ...result }),
    { mode: 0o600 });
  const events = result.stdout.split('\n').filter(Boolean).map(JSON.parse);
  const failure = events.find(event => event.type === 'turn.failed' || event.type === 'error');
  assert.equal(result.code, 0, failure?.error?.message ?? failure?.message ?? result.stderr.slice(-800));
  assert(events.some(event => event.type === 'turn.completed'), 'Codex turn did not complete');
  const sessionId = events.find(event => event.type === 'thread.started')?.thread_id;
  assert(sessionId, 'Codex did not return a session id');
  const commands = events.filter(event =>
    event.type === 'item.completed' && event.item.type === 'command_execution').map(event => event.item);
  assert.equal(commands.length, 1, `Expected one command, saw ${commands.length}`);
  assert.equal(commands[0].exit_code, 0, 'Investigation command failed');
  const answer = events.findLast(event =>
    event.type === 'item.completed' && event.item.type === 'agent_message')?.item.text ?? '';
  const outputs = (await transcript(sessionId))
    .filter(entry => entry.type === 'response_item' &&
      /^(function_call_output|custom_tool_call_output)$/.test(entry.payload.type))
    .map(entry => commandOutput(entry.payload)).filter(output => output !== undefined);
  assert(outputs.length, 'No recorded model-visible command output');
  return {
    answer,
    command: commands[0].command,
    visible: outputs.join(''),
    durationMs: result.durationMs,
    usage: events.find(event => event.type === 'turn.completed')?.usage,
  };
}

function prompt(task, command) {
  return `This is an authorized read-only investigation of the jev-pruner source.
Run exactly this one command and no other tools. Preserve its argument quoting and request
at least 30000 output tokens from the shell tool:
${command}

${task.question}
Do not read archives or source files with another command. Answer only from this command's result.`;
}

const results = [];
try {
  const prepared = [];
  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index];
    const searchArgs = [
      '--sort=path', '--glob=!codex-real-tasks.mjs', '--glob=!codex-real-tasks-report.mjs', ...task.args,
    ];
    const directory = join(workspace, `task-${index + 1}`);
    const clone = await execute('git', ['clone', '--quiet', '--no-local', repo, directory]);
    assert.equal(clone.code, 0, clone.stderr);
    const original = await execute('rg', searchArgs, { cwd: directory });
    assert.equal(original.code, 0, original.stderr);
    assert(estimateTokens(original.stdout) > 10_000, `${task.name}: output did not cross threshold`);
    for (const fragment of task.evidence) {
      assert(original.stdout.includes(fragment), `${task.name}: search omitted required evidence: ${fragment}`);
    }
    prepared.push({ task, searchArgs, directory, original });
  }

  for (const { task, searchArgs, directory, original } of prepared) {
    const baselineCommand = ['rg', ...searchArgs].map(quote).join(' ');
    const baseline = await codexTurn(directory, prompt(task, baselineCommand), 'baseline');
    assert.equal(baseline.visible, original.stdout, `${task.name}: baseline host changed output`);

    await mkdir(join(directory, 'captures'), { mode: 0o700 });
    const prunedCommand = [
      'node', '--import', observer, wrapper, '--', 'rg', ...searchArgs,
    ].map(quote).join(' ');
    const pruned = await codexTurn(directory, prompt(task, prunedCommand), 'pruned');
    assert(/^\[fast-jev-output trimmed/m.test(pruned.visible), `${task.name}: no pruning marker`);
    const archive = pruned.visible.match(
      /^\[fast-jev-output full output: (.*?) \(Read or grep it if needed\)\]/m,
    )?.[1];
    assert(archive, `${task.name}: no archive footer`);
    assert.equal(await readFile(archive, 'utf8'), original.stdout, `${task.name}: archive mismatch`);
    const originalLines = new Set(original.stdout.split('\n'));
    for (const line of pruned.visible.split('\n').filter(Boolean)) {
      if (!line.startsWith('[fast-jev-output')) {
        assert(originalLines.has(line), `${task.name}: rewritten text or host truncation`);
      }
    }

    for (const run of [baseline, pruned]) {
      try {
        const answer = JSON.parse(run.answer.replace(/^```(?:json)?\s*\n|\n```\s*$/g, ''));
        run.correct = isDeepStrictEqual(answer, task.expected);
      } catch {
        run.correct = false;
      }
    }

    const captures = await Promise.all((await readdir(join(directory, 'captures')))
      .map(async file => JSON.parse(await readFile(join(directory, 'captures', file), 'utf8'))));
    assert(captures.length, `${task.name}: no Jev requests captured`);
    assert(captures.every(capture => capture.response?.status === 200),
      `${task.name}: Jev request failed`);
    const row = {
      name: task.name,
      original: original.stdout,
      originalBytes: Buffer.byteLength(original.stdout),
      estimatedTokens: estimateTokens(original.stdout),
      baseline,
      pruned,
      prunedBytes: Buffer.byteLength(pruned.visible),
      reduction: 100 * (1 - Buffer.byteLength(pruned.visible) / Buffer.byteLength(original.stdout)),
      archive,
      archiveSha256: createHash('sha256').update(original.stdout).digest('hex'),
      jevRequests: captures.length,
      expected: task.expected,
      evidence: task.evidence.map(fragment => ({ fragment, retained: pruned.visible.includes(fragment) })),
    };
    row.passed = baseline.correct && pruned.correct && row.evidence.every(item => item.retained);
    assert(row.prunedBytes < row.originalBytes, `${task.name}: pruning did not reduce output`);
    results.push(row);
    await writeFile(join(workspace, 'progress.json'), JSON.stringify(results, null, 2),
      { mode: 0o600 });
    console.log(JSON.stringify({
      task: row.name,
      passed: row.passed,
      baselineCorrect: baseline.correct,
      prunedCorrect: pruned.correct,
      originalBytes: row.originalBytes,
      prunedBytes: row.prunedBytes,
      reduction: row.reduction,
      jevRequests: row.jevRequests,
    }));
  }
} catch (error) {
  await writeFile(join(workspace, 'result.json'), JSON.stringify({
    passed: false, started, error: error.message, tasks: results,
  }, null, 2), { mode: 0o600 });
  throw error;
}

const result = {
  passed: results.every(task => task.passed),
  started,
  codex: (await execute('codex', ['--version'])).stdout.trim(),
  model: model ?? 'Codex default',
  installed,
  revision: (await execute('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim(),
  tasks: results,
};
await writeFile(join(workspace, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
assert(result.passed, 'Source comparison failed; inspect result.json for every answer and retained fact.');
console.log(`PASS: ${results.length} real source-investigation tasks, paired baseline and pruning. Evidence: ${workspace}`);
