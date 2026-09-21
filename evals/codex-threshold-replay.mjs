import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { codexMessages } from '../dist/codex/history.js';
import { buildJevRequest, estimateTokens, parseJevResponse } from '../dist/jev.js';
import { trimOutput } from '../dist/output.js';
import { diagnosticSectionLines } from '../dist/retention.js';
import { commandOutput } from '../tests/fixtures/codex-transcript.mjs';
import { thresholdArms } from './codex-thresholds.mjs';

assert(process.argv[2] && process.argv[3] && process.env.TYPESAFE_API_KEY,
  'Usage: TYPESAFE_API_KEY=... node evals/codex-threshold-replay.mjs <saved-trial> <new-results>');
const [trial, root] = process.argv.slice(2).map(value => resolve(value));
const thresholds = Object.values(thresholdArms(process.env.JEV_EVAL_THRESHOLDS ?? '10000,5000'));
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const rawDirectory = join(trial, 'observer/raw');
const candidates = await Promise.all((await readdir(rawDirectory)).sort().map(async file =>
  ({ file, ...await read(join(rawDirectory, file)) })));
const raw = candidates.find(capture =>
  estimateTokens(capture.output) > Math.min(...thresholds) &&
  estimateTokens(capture.output) <= Math.max(...thresholds));
assert(raw, 'No saved output between the selected token thresholds');
const responses = await read(join(trial, 'responses.json'));
const outputIndex = responses.findIndex(payload => commandOutput(payload) === raw.output);
assert(outputIndex > 0, 'Saved output not found exactly in the model transcript');
const messages = codexMessages([
  JSON.stringify({ type: 'session_meta', payload: { id: 'threshold-replay' } }),
  ...responses.slice(0, outputIndex).map(payload => JSON.stringify({ type: 'response_item', payload })),
].join('\n'), 'threshold-replay');
const call = responses.slice(0, outputIndex).findLast(payload =>
  payload.type === 'function_call' && payload.name === 'exec_command');
assert(call, 'Missing command');
const lines = raw.output.split('\n');
const protectedLines = [...diagnosticSectionLines(lines)].map(index => lines[index]);
assert(protectedLines.length > 0, 'Missing diagnostic-section preservation checks');
await mkdir(root, { mode: 0o700 });
const save = (name, value) => writeFile(join(root, name), JSON.stringify(value, null, 2), { mode: 0o600 });
await writeFile(join(root, 'original.txt'), raw.output, { mode: 0o600 });
await save('protocol.json', {
  created: new Date().toISOString(), trial, raw_file: raw.file, thresholds,
  output_sha256: createHash('sha256').update(raw.output).digest('hex'),
  estimated_tokens: estimateTokens(raw.output),
  scope: 'Live Jev scoring of one previously seen output with identical saved pre-output history. No Codex repair inference.',
});
const rows = [];
for (const minTokens of thresholds) {
  const captures = [];
  let decision;
  const result = await trimOutput({
    command: JSON.parse(call.arguments).cmd, output: raw.output, exitCode: raw.code, messages,
    goal: messages.filter(message => message.role === 'user' && message.text)
      .slice(-3).map(message => message.text.slice(0, 500)).join('\n'),
    fullOutputPath: join(root, 'original.txt'),
  }, {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey: process.env.TYPESAFE_API_KEY }, state, questions);
      const capture = { request: JSON.parse(request.body) };
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
      }
    },
  }, { minTokens, onDecision: value => { decision = value; } });
  const complete = captures.every(capture => capture.response?.status === 200 &&
    Number.isFinite(JSON.parse(capture.response.body).usage?.input_tokens));
  const inputTokens = complete ? captures.reduce((total, capture) =>
    total + JSON.parse(capture.response.body).usage.input_tokens, 0) : null;
  const row = {
    min_tokens: minTokens, decision, pruned: result.trimmed,
    original_chars: raw.output.length, delivered_chars: result.output.length,
    original_estimated_tokens: estimateTokens(raw.output),
    diagnostic_lines_preserved: protectedLines.every(line => result.output.includes(line)),
    jev_requests: captures.length, jev_usage_complete: complete,
    jev_input_tokens: inputTokens, jev_cost_usd: complete ? inputTokens * 0.042 / 1e6 : null,
  };
  await save(`${minTokens}-captures.json`, captures);
  await writeFile(join(root, `${minTokens}-output.txt`), result.output, { mode: 0o600 });
  rows.push(row);
  await save('results.json', rows);
  console.log(JSON.stringify(row));
}
assert(rows.every(row => row.diagnostic_lines_preserved), 'Diagnostic preservation failed');
