import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { contextPath } from '../dist/codex/context.js';
import { estimateTokens } from '../dist/jev.js';
import { commandOutput } from '../tests/fixtures/codex-transcript.mjs';
import { execute, quote, repo } from './codex-repair-workloads.mjs';
import { assertNoEvidenceLeak, assertNoEvidenceStateLeak, evidenceMarker, externalEvidenceDirectory } from './observer/evidence-isolation.mjs';

const historicalSource = process.env.JEV_HISTORICAL_SOURCE_ROOT;
const { cases, grade, prepare } = await import(historicalSource
  ? pathToFileURL(join(historicalSource, 'evals/codex-historical-workloads.mjs')).href
  : './codex-repair-workloads.mjs');
const names = process.env.JEV_EVAL_CASES?.split(',') ?? Object.keys(cases);
assert(names.length > 0 && new Set(names).size === names.length && names.every(name => Object.hasOwn(cases, name)));
const repetitions = Number(process.env.JEV_EVAL_REPETITIONS ?? 3);
assert(Number.isInteger(repetitions) && repetitions > 0);
const outputBudget = historicalSource ? 100_000 : 30_000;
const preserveExit = process.env.JEV_EVAL_PRESERVE_EXIT === 'true';

assert(process.argv[2], 'Usage: node evals/codex-repair-cohort.mjs <new-evidence-directory> [preflight|run]');
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY.');
const root = resolve(process.argv[2]);
const phase = process.argv[3] ?? 'preflight';
assert(['preflight', 'run'].includes(phase));
const plugin = process.env.JEV_CODEX_PLUGIN_ROOT ??
  join(homedir(), '.codex/plugins/cache/jev-pruner-codex/jev-pruner/0.1.0');
const diagnostic = join(repo, 'evals/observer/codex-diagnostic.mjs');
const skill = join(plugin, 'codex/skills/jev-pruner');
const hash = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2), { mode: 0o600 });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const list = async path => readdir(path).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const model = 'gpt-5.5';
const frozenFiles = [
  'evals/codex-repair-cohort.mjs', 'evals/codex-repair-workloads.mjs',
  'evals/observer/codex-diagnostic.mjs', 'tests/fixtures/codex-observer.mjs',
  'evals/observer/evidence-isolation.mjs',
  'tests/fixtures/codex-transcript.mjs', 'codex/skills/jev-pruner/SKILL.md',
  ...(await readdir(join(repo, 'dist'), { recursive: true }))
    .filter(path => path.endsWith('.js')).map(path => `dist/${path}`),
];
const hashes = {};
for (const file of frozenFiles) {
  hashes[file] = hash(await readFile(join(repo, file)));
  if (file.startsWith('dist/')) assert.equal(hash(await readFile(join(plugin, file))), hashes[file]);
}
assert.equal((await execute('codex --version', repo)).stdout.trim(), 'codex-cli 0.152.1');
const login = await execute('codex login status', repo);
assert.match(login.stdout + login.stderr, /Logged in using ChatGPT/);
const pairs = names.flatMap((name, index) => Array.from({ length: repetitions }, (_, i) => i + 1).map(repetition => ({
  id: `${name}-${repetition}`, name, repetition,
  arms: (index + repetition) % 2 ? ['native', 'pruned'] : ['pruned', 'native'],
})));
const historicalHashes = historicalSource ? Object.fromEntries(await Promise.all([
  'evals/codex-historical-workloads.mjs', 'evals/codex-repair-workloads.mjs',
  ...names.flatMap(name => ['case.json', 'regression.patch', 'repair.patch', 'setup.sh']
    .map(file => `evals/historical/${name}/${file}`)),
].map(async file => [file, hash(await readFile(join(historicalSource, file)))]))) : {};
let protocol;
if (phase === 'preflight') {
  await mkdir(root, { mode: 0o700 });
  protocol = {
    created: new Date().toISOString(), revision: (await execute('git rev-parse HEAD', repo)).stdout.trim(),
    hashes, model, version: 'codex-cli 0.152.1', pairs,
    historicalSource, historicalHashes, outputBudget, preserveExit,
    evidence_layout: 'observer/{raw,jev} outside workspace; marker/path leakage invalidates instrumentation',
    tool_versions: (await execute('node --version && npm --version && python3 --version && python3 -m pytest --version && node node_modules/typescript/bin/tsc --version', repo)).stdout.trim(),
    scope: historicalSource ? `Targeted repeat of historical ${names.join(', ')} defects; previously seen tasks, not unseen validation.`
      : 'Constructed repair projects using real tsc, pytest, and offline npm. Not a real-project benchmark.',
    controls: `Fresh sessions/workspaces, identical prompts within pairs, balanced arm order, low reasoning, ${outputBudget}-token tool budget. Same plugin/skill loaded once in both arms. Shared subscription caching uncontrolled.`,
    diagnostic_adapter: preserveExit
      ? 'Collector merges stderr into stdout and preserves the real exit code. Only pruned arm invokes the production wrapper.'
      : 'Collector merges stderr into stdout, prints the true exit code, and exits zero to make failing diagnostics eligible.',
    inclusion: 'Both audited arms with complete usage, and actual pruning in plugin arm. No filtering on task success, answer correctness, or required-fact retention.',
    task_grading: 'Independent verifier plus hidden semantic oracle and source integrity; final factual outcome and strict JSON format scored separately.',
    preflight: `One excluded pruned repair per workflow must activate before ${pairs.length * 2} trials. No retries or tuning after freeze.`,
    prices: { input: 5, cached_input: 0.5, output: 30, jev_input: 0.042, unit: 'USD per million tokens',
      sources: ['https://developers.openai.com/api/docs/models/gpt-5.5', 'https://openrouter.ai/typesafe/jev-1.13'],
      caveat: 'Reference estimates, not ChatGPT subscription charges or TypeSafe invoices.' },
  };
  await save(join(root, 'protocol.json'), protocol);
} else {
  protocol = await read(join(root, 'protocol.json'));
  assert.deepEqual(hashes, protocol.hashes, 'Protocol source changed');
  assert.deepEqual(historicalHashes, protocol.historicalHashes, 'Historical source changed');
  assert.deepEqual(pairs, protocol.pairs, 'Trial plan changed');
  assert.equal(outputBudget, protocol.outputBudget);
  assert.equal(preserveExit, protocol.preserveExit);
  const preflight = await read(join(root, 'preflight.json'));
  assert.equal(preflight.length, names.length);
  assert(preflight.every(row => row.audit_pass && row.pruned), 'Activation preflight failed');
  assert.equal((await list(join(root, 'trials'))).length, 0, 'Trials already started');
}
await mkdir(join(root, phase === 'preflight' ? 'preflight' : 'trials'));
const rows = [];

async function tree(directory) {
  const result = {};
  const walk = async (path, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.jev-pruner', '.npm-cache', '__pycache__', '.pytest_cache'].includes(entry.name)) continue;
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), relative + '/');
      else if (entry.isFile() && relative !== 'installation-ok.json') {
        result[relative] = hash(await readFile(join(path, entry.name)));
      }
    }
  };
  await walk(directory);
  return result;
}

async function trial(pair, arm) {
  for (const [file, expected] of Object.entries(protocol.hashes)) {
    assert.equal(hash(await readFile(join(repo, file))), expected, `Source changed: ${file}`);
  }
  for (const [file, expected] of Object.entries(protocol.historicalHashes)) {
    assert.equal(hash(await readFile(join(historicalSource, file))), expected, `Fixture source changed: ${file}`);
  }
  const evidence = join(root, phase === 'preflight' ? 'preflight' : 'trials', `${pair.id}-${arm}`);
  await mkdir(evidence, { mode: 0o700 });
  const cwd = join(evidence, 'workspace');
  await prepare(pair.name, cwd);
  const observerDirectory = await externalEvidenceDirectory(join(evidence, 'observer'), cwd);
  const rawDirectory = await externalEvidenceDirectory(join(observerDirectory, 'raw'), cwd);
  const captureDirectory = await externalEvidenceDirectory(join(observerDirectory, 'jev'), cwd);
  const initial = await tree(cwd);
  await save(join(evidence, 'fixture-hashes.json'), initial);
  const command = `node ${quote(diagnostic)} ${pair.name}`;
  const prompt = `${cases[pair.name].question}
First read ${quote(join(skill, 'SKILL.md'))} exactly once. The evaluation adapter already applies the assigned output treatment; do not add wrappers.
Next run exactly this diagnostic command with yield_time_ms=1000 and max_output_tokens=${outputBudget}:
${command}
Poll it to completion with max_output_tokens=${outputBudget}. Then inspect project files, repair the defect, and rerun that same diagnostic command to verify. Use it for all verbose build/test/install runs.
${preserveExit ? 'The collector merges stdout/stderr and preserves the real exit status, also printing it for clarity.'
    : 'The collector merges stdout/stderr and prints the real exit status, while its own exit status is zero. Judge success from the printed Exit status.'}
Do not inspect or modify the collector, harness, captures, environment variables, source templates, hidden oracle, or any files outside the workspace except the skill. Archive reads from .jev-pruner are allowed if needed.
Return only a JSON object with outcome ("fixed" or "not_fixed"), cause, and change. Do not delegate or use network resources.`;
  await writeFile(join(evidence, 'prompt.txt'), prompt);
  const args = [
    'exec', '--model', model, '--sandbox', 'workspace-write', '--add-dir', observerDirectory,
    '-c', 'forced_login_method="chatgpt"', '-c', 'sandbox_workspace_write.network_access=true',
    '-c', 'model_reasoning_effort="low"', '-c', `tool_output_token_limit=${outputBudget}`,
    '--dangerously-bypass-hook-trust', '--skip-git-repo-check', '--json', prompt,
  ];
  const result = await execute(`codex ${args.map(quote).join(' ')}`, cwd, {
    ...process.env, JEV_EVAL_ARM: arm, JEV_CODEX_PLUGIN_ROOT: plugin,
    JEV_EVAL_CAPTURE_DIR: rawDirectory, JEV_OBSERVER_CAPTURE_DIR: captureDirectory,
  }, 600_000);
  await save(join(evidence, 'execution.json'), result);
  const row = { pair: pair.id, workload: pair.name, arm, seconds: result.seconds, evidence_isolation_pass: false };
  const after = await tree(cwd);
  row.unexpected_changes = [...new Set([...Object.keys(initial), ...Object.keys(after)])]
    .filter(file => !cases[pair.name].editable.includes(file) && initial[file] !== after[file]);
  const oracle = await grade(pair.name, cwd);
  await save(join(evidence, 'oracle.json'), oracle);
  row.task_pass = oracle.passed && row.unexpected_changes.length === 0;
  try {
    assert(!result.timedOut && result.code === 0, 'Codex process failed');
    const events = result.stdout.split('\n').filter(Boolean).map(JSON.parse);
    assert(!events.some(event => ['turn.failed', 'error'].includes(event.type)), 'Failed turn');
    row.usage = events.find(event => event.type === 'turn.completed')?.usage;
    assert(row.usage, 'Missing usage');
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      assert(Number.isFinite(row.usage[key]) && row.usage[key] >= 0, `Invalid ${key}`);
    }
    assert(row.usage.cached_input_tokens <= row.usage.input_tokens);
    assert.equal(row.usage.cache_write_input_tokens ?? 0, 0);
    row.uncached_input_tokens = row.usage.input_tokens - row.usage.cached_input_tokens;
    row.model_estimated_usd = (row.uncached_input_tokens * 5 +
      row.usage.cached_input_tokens * 0.5 + row.usage.output_tokens * 30) / 1e6;
    row.model_all_uncached_usd = (row.usage.input_tokens * 5 + row.usage.output_tokens * 30) / 1e6;
    const session = events.find(event => event.type === 'thread.started')?.thread_id;
    assert(session, 'Missing session');
    const pointer = await read(contextPath(session));
    const transcript = (await readFile(pointer.transcript, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    const responses = transcript.filter(entry => entry.type === 'response_item').map(entry => entry.payload);
    await save(join(evidence, 'responses.json'), responses);
    assert(transcript.some(entry => entry.type === 'turn_context' && entry.payload.model === model));
    const commands = responses.filter(entry => entry.type === 'function_call' && entry.name === 'exec_command')
      .map(entry => JSON.parse(entry.arguments).cmd);
    assert(commands.filter(cmd => cmd.includes(diagnostic)).every(cmd => cmd.trim() === command),
      'Diagnostic command modified or source inspected');
    assert(!responses.some(entry => entry.type === 'function_call' && /spawn_agent|delegate/.test(entry.name)),
      'Unexpected delegation');
    row.commands = events.filter(event => event.type === 'item.completed' &&
      event.item.type === 'command_execution').map(event => event.item.command);
    row.skill_reads = row.commands.filter(cmd => cmd.includes(join(skill, 'SKILL.md'))).length;
    assert.equal(row.skill_reads, 1, 'Unequal skill loading');
    row.archive_path_commands = row.commands.filter(cmd => cmd.includes('.jev-pruner'));
    assert.equal((await list(join(cwd, 'captures'))).length, 0, 'Legacy captures inside workspace');
    assert.equal((await list(join(cwd, '.eval-raw'))).length, 0, 'Raw diagnostics inside workspace');
    const raw = [];
    for (const file of await list(rawDirectory)) raw.push(await read(join(rawDirectory, file)));
    assert(raw.every(capture => capture.evidenceMarker === evidenceMarker), 'Missing evidence marker');
    const outputs = responses.filter(entry => /^(function_call_output|custom_tool_call_output)$/.test(entry.type))
      .map(commandOutput).filter(text => text !== undefined);
    for (const text of outputs) assertNoEvidenceLeak(text, [observerDirectory]);
    row.evidence_isolation_pass = true;
    const visible = outputs.filter(text => /(?:^|\n)Exit status: \d+\n/.test(text));
    assert(raw.length > 0, 'Diagnostic never ran');
    assert.equal(visible.length, raw.length, 'Missing or split diagnostic output');
    row.diagnostics = [];
    const unused = [...raw];
    for (let index = 0; index < visible.length; index += 1) {
      const text = visible[index];
      assert(!/\d+ (?:tokens|characters) truncated|Warning: truncated output/.test(text), 'Host truncation');
      const pruned = text.includes('[fast-jev-output trimmed');
      let original;
      if (pruned) {
        assert.equal(arm, 'pruned');
        const archive = text.match(/\[fast-jev-output full output: (.*?) \(Read or grep it if needed\)\]/)?.[1];
        assert(archive, 'Missing archive footer');
        original = await readFile(archive, 'utf8');
        const lines = new Set(original.split('\n'));
        assert(text.split('\n').every(line => !line || line.startsWith('[fast-jev-output') || lines.has(line)),
          'Retained text changed');
        assert(text.length < original.length);
      } else {
        original = text;
      }
      const match = unused.findIndex(entry => entry.output === original);
      assert(match >= 0, 'Original/archive does not match captured output');
      const [captured] = unused.splice(match, 1);
      row.diagnostics.push({
        original_chars: original.length, visible_chars: text.length, pruned,
        original_estimated_tokens: estimateTokens(original), exit_code: captured.code,
        archive_exact: pruned ? true : null, retained_lines_verbatim: true,
        required_facts_visible: index === 0 ? cases[pair.name].evidence.every(fact => text.includes(fact)) : null,
      });
      await writeFile(join(evidence, `visible-${index}.txt`), text);
    }
    assert(row.diagnostics[0].original_estimated_tokens > 10_000, 'Below activation threshold');
    assert.notEqual(row.diagnostics[0].exit_code, 0, 'Fixture did not fail');
    row.pruned = row.diagnostics.some(output => output.pruned);
    row.required_facts_visible = row.diagnostics[0].required_facts_visible;
    row.answer = events.findLast(event => event.type === 'item.completed' &&
      event.item.type === 'agent_message')?.item.text ?? '';
    try {
      const parsed = JSON.parse(row.answer);
      row.format_pass = ['fixed', 'not_fixed'].includes(parsed.outcome) &&
        ['cause', 'change'].every(key => typeof parsed[key] === 'string');
    } catch {
      row.format_pass = false;
    }
    row.reported_fixed = /"outcome"\s*:\s*"fixed"/.test(row.answer);
    row.factual_outcome_pass = row.reported_fixed === row.task_pass;
    row.audit_pass = true;
  } catch (error) {
    row.audit_pass = false;
    row.error = String(error);
  }
  const captures = await list(captureDirectory);
  row.jev_requests = captures.length;
  row.jev_input_tokens = 0;
  row.jev_statuses = [];
  row.jev_usage_complete = true;
  row.jev_summed_seconds = 0;
  for (const file of captures) {
    const capture = await read(join(captureDirectory, file));
    try {
      assert.equal(capture.evidenceMarker, evidenceMarker);
      assertNoEvidenceStateLeak(capture.request.state, [observerDirectory]);
    } catch (error) {
      row.audit_pass = false;
      row.evidence_isolation_pass = false;
      row.error = [row.error, String(error)].filter(Boolean).join('; ');
    }
    row.jev_statuses.push(capture.response?.status ?? null);
    row.jev_summed_seconds += capture.durationMs / 1000;
    const usage = capture.response?.body ? JSON.parse(capture.response.body).usage : undefined;
    if (Number.isFinite(usage?.input_tokens)) row.jev_input_tokens += usage.input_tokens;
    else row.jev_usage_complete = false;
  }
  row.jev_estimated_usd = row.jev_usage_complete ? row.jev_input_tokens * 0.042 / 1e6 : null;
  if ((arm === 'native' && captures.length) || (row.pruned && !captures.length) ||
      !row.jev_usage_complete || row.jev_statuses.some(status => status !== 200)) {
    row.audit_pass = false;
    row.error = [row.error, 'Jev evidence incomplete or condition mismatch'].filter(Boolean).join('; ');
  }
  if (row.model_estimated_usd !== undefined && row.jev_estimated_usd !== null) {
    row.total_estimated_usd = row.model_estimated_usd + row.jev_estimated_usd;
    row.total_all_uncached_usd = row.model_all_uncached_usd + row.jev_estimated_usd;
  }
  await save(join(evidence, 'result.json'), row);
  rows.push(row);
  await save(join(root, phase === 'preflight' ? 'preflight.json' : 'results.json'), rows);
  console.log(`${pair.id}-${arm}: audit=${row.audit_pass} pruning=${row.pruned} task=${row.task_pass} Jev=${row.jev_requests} ${row.error ?? ''}`);
}

if (phase === 'preflight') {
  for (const name of names) await trial({ id: name, name }, 'pruned');
  assert(rows.every(row => row.audit_pass && row.pruned), 'Preflight did not qualify all workflows');
} else {
  for (const pair of pairs) for (const arm of pair.arms) await trial(pair, arm);
  const qualifying = pairs.filter(pair => {
    const matched = rows.filter(row => row.pair === pair.id);
    return matched.length === 2 && matched.every(row => row.audit_pass) &&
      matched.some(row => row.arm === 'pruned' && row.pruned);
  }).map(pair => pair.id);
  await save(join(root, 'selection.json'), {
    qualifying_pairs: qualifying,
    excluded_pairs: pairs.filter(pair => !qualifying.includes(pair.id)).map(pair => pair.id),
    note: 'Accuracy never determines inclusion. Non-pruning trials remain diagnostics.',
  });
  console.log(`${qualifying.length}/${pairs.length} qualifying pairs`);
}
