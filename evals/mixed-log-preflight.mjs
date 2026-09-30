import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexMessages } from '../dist/codex/history.js';
import { buildJevRequest, parseJevResponse } from '../dist/jev.js';
import { classifyOutput, trimOutput } from '../dist/output.js';
import { commandOutput } from '../tests/fixtures/codex-transcript.mjs';
import { execute, repo } from './codex-repair-workloads.mjs';

assert(process.argv[2] && process.argv[3] && process.argv[4],
  'Usage: node evals/mixed-log-preflight.mjs <saved-evidence> <diagnosis.json> <new-results>');
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY');
const [evidence, diagnosisPath, root] = process.argv.slice(2).map(path => resolve(path));
const load = async path => JSON.parse(await readFile(path, 'utf8'));
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const diagnosis = await load(diagnosisPath);
const names = ['click', 'flask', 'hatch'];
const selected = names.map(name => {
  const row = diagnosis.outputs.find(item => item.workload === name && item.gate === 'document');
  assert(row, `No saved document-gated output for ${name}`);
  return row;
});
const sourceFiles = ['evals/mixed-log-preflight.mjs', 'tests/fixtures/codex-transcript.mjs',
  ...(await readdir(join(repo, 'dist'), { recursive: true })).filter(file => file.endsWith('.js')).map(file => `dist/${file}`)];
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
  [file, hash(await readFile(join(repo, file)))])));
await mkdir(root, { mode: 0o700 });
await save('protocol.json', {
  created: new Date().toISOString(), revision: (await execute('git rev-parse HEAD', repo)).stdout.trim(),
  hashes, selected, model: 'jev-latest',
  scope: 'Targeted live scoring of three saved historical failure logs, with saved pre-output conversation context.',
  controls: 'Default production thresholds/chunks/request budget; no size cap. Same logs also checked as explicit documents. Extra Click run requires a normally disposable progress line.',
  limitation: 'No Codex inference in this stage. Activation and retention only; no task accuracy or combined cost conclusion.',
  prices: { jev_input_per_million: 0.042, reference: 'https://openrouter.ai/typesafe/jev-1.13', note: 'Reference estimate, not an invoice.' },
});
const rows = [];
for (const selectedRow of selected) {
  const directory = join(evidence, 'trials', selectedRow.trial);
  const raw = await load(join(directory, 'workspace/.eval-raw', selectedRow.raw_file));
  const responses = await load(join(directory, 'responses.json'));
  const outputIndex = responses.findIndex(payload => commandOutput(payload) === raw.output);
  assert(outputIndex > 0, 'Could not identify saved output in transcript');
  const baseMessages = codexMessages([
    JSON.stringify({ type: 'session_meta', payload: { id: 'mixed-preflight' } }),
    ...responses.slice(0, outputIndex).map(payload => JSON.stringify({ type: 'response_item', payload })),
  ].join('\n'), 'mixed-preflight');
  for (const mode of ['repair', 'document', ...(selectedRow.workload === 'click' ? ['required-progress'] : [])]) {
    const required = mode === 'required-progress'
      ? raw.output.split('\n').filter(line => /^\S+::\S+ +PASSED/.test(line))[200] : undefined;
    assert(mode !== 'required-progress' || required);
    const messages = [...baseMessages, ...(required ? [{
      role: 'user', text: `Preserve this exact test status line for my report: ${required}`, toolUses: [],
    }] : [])];
    const goal = messages.filter(message => message.role === 'user' && message.text)
      .slice(-3).map(message => message.text.slice(0, 500)).join('\n');
    const label = `${selectedRow.workload}-${mode}`;
    const input = {
      command: mode === 'document' ? 'cat saved-test-log.txt'
        : `node diagnostic-collector.mjs --collect ${selectedRow.workload}`,
      output: raw.output, exitCode: raw.code, messages, goal, fullOutputPath: `/archive/${label}.txt`,
    };
    const captures = [];
    let decision;
    const started = Date.now();
    const result = await trimOutput(input, {
      async ask(state, questions) {
        const request = buildJevRequest({ apiKey: process.env.TYPESAFE_API_KEY }, state, questions);
        const at = Date.now();
        const capture = { request: JSON.parse(request.body), started: at };
        captures.push(capture);
        try {
          const response = await fetch(request.url, {
            method: request.method, headers: request.headers, body: request.body,
            signal: AbortSignal.timeout(30_000),
          });
          const body = await response.text();
          capture.response = { status: response.status, body };
          return parseJevResponse(response.status, response.ok, body);
        } catch (error) {
          capture.error = String(error);
          throw error;
        } finally {
          capture.durationMs = Date.now() - at;
        }
      },
    }, { onDecision: value => { decision = value; } });
    const suffix = raw.output.search(/^=+ (?:FAILURES|ERRORS) =+/m);
    assert(suffix >= 0);
    const usageComplete = captures.every(capture => capture.response?.status === 200 &&
      Number.isFinite(JSON.parse(capture.response.body).usage?.input_tokens));
    const tokens = usageComplete ? captures.reduce((total, capture) =>
      total + JSON.parse(capture.response.body).usage.input_tokens, 0) : null;
    const row = {
      label, source: selectedRow, mode, category: classifyOutput(input.command, input.output),
      decision, pruned: result.trimmed, before: raw.output.length, after: result.output.length,
      diagnostic_suffix_intact: result.output.includes(raw.output.slice(suffix)),
      required_line_intact: required ? result.output.includes(required) : null,
      document_unchanged: mode === 'document' ? result.output === raw.output && captures.length === 0 : null,
      seconds: (Date.now() - started) / 1000, requests: captures.length,
      usage_complete: usageComplete, jev_input_tokens: tokens,
      jev_reference_usd: tokens === null ? null : tokens * 0.042 / 1e6,
      source_sha256: hash(raw.output),
    };
    await save(`${label}.json`, { row, input, required, result, captures });
    rows.push(row);
    await save('results.json', rows);
    console.log(JSON.stringify(row));
    assert(row.diagnostic_suffix_intact, 'Diagnostic loss');
    assert(row.required_line_intact !== false, 'Required progress lost');
    assert(row.document_unchanged !== false, 'Document changed');
    assert(usageComplete, 'Jev request/usage incomplete');
  }
}
