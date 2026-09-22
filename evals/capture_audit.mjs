import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { estimateTokens } from '../dist/jev.js';
import { classifyOutput, looksBinary } from '../dist/output.js';
import { classifyInformation, diagnosticSectionLines, isProtectedLine } from '../dist/retention.js';
import { looksSecret } from '../dist/secrets.js';
import { assertNoEvidenceLeak } from './observer/evidence-isolation.mjs';

const wrapper = '/opt/jev-eval/evals/capture_command.mjs';
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const list = path => readdir(path).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
const events = text => text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function outputStats(command, bytes) {
  const text = bytes.toString('utf8');
  const utf8 = bytes.equals(Buffer.from(text));
  if (!utf8) return { bytes: bytes.length, utf8, tokens: null, band: 'non-UTF-8', candidate: false };
  const tokens = estimateTokens(text);
  const category = classifyOutput(command, text);
  const sensitive = looksSecret(command, text);
  const binary = looksBinary(text);
  const lines = text.split('\n');
  const sections = diagnosticSectionLines(lines);
  const protectedLines = lines.filter((line, index) =>
    sections.has(index) || isProtectedLine(line) || classifyInformation(line) === 'reference');
  return {
    bytes: bytes.length, chars: text.length, utf8, empty: bytes.length === 0, tokens,
    band: tokens < 1000 ? '<1000' : tokens <= 5000 ? '1000–5000' : tokens <= 10000 ? '>5000–10000' : '>10000',
    category, information: classifyInformation(text), sensitive, binary,
    protected_lines: protectedLines.length,
    protected_line_tokens: estimateTokens(protectedLines.join('\n')),
    candidate: tokens > 10000 && category !== 'document' && !sensitive && !binary,
  };
}

export function nativeOutputs(transcript) {
  const calls = new Map();
  const shell = [];
  const images = [];
  const others = [];
  const outputs = [];
  for (const event of transcript) {
    if (event.type !== 'response_item') continue;
    const item = event.payload;
    if (item.type === 'function_call') {
      const args = JSON.parse(item.arguments);
      const call = {
        call_id: item.call_id, name: item.name,
        command: args.cmd ?? args.command ?? '',
        budget: args.max_output_tokens ?? 10000,
        session_id: args.session_id ?? null,
      };
      call.wrapped = typeof call.command === 'string' && call.command.includes(wrapper);
      call.shell = /(?:exec_command|shell_command|shell)$/.test(item.name);
      call.poll = /write_stdin$/.test(item.name);
      calls.set(item.call_id, call);
      if (call.shell) shell.push(call);
      else if (/view_image$/.test(item.name)) images.push(call);
      else if (!call.poll) others.push(call);
    } else if (item.type === 'function_call_output') {
      const call = calls.get(item.call_id);
      if (!call?.shell && !call?.poll) continue;
      const raw = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
      const match = /^(?:Final output|Output):\n/m.exec(raw);
      const text = match ? raw.slice(match.index + match[0].length) : raw;
      outputs.push({
        call_id: item.call_id, name: call.name,
        stdout_stderr_combined: true, chars: text.length, tokens: estimateTokens(text),
        empty: text.length === 0,
        native_truncation: /…\d+ tokens truncated…|\.\.\. \d+ bytes omitted \.\.\.|Warning: truncated output/.test(raw),
        requested_budget: call.budget,
      });
    }
  }
  return { shell, images, others, outputs };
}

export async function auditTrial(root, planned, protocol) {
  const row = {
    ...planned, issues: [], raw: [], native: { shell: [], images: [], others: [], outputs: [] },
    reward: null, usage: null, final_answer: null, jev_requests: 0, pruned_outputs: 0,
  };
  const jobs = join(root, 'jobs', planned.task);
  const trials = (await list(jobs)).filter(name => name.startsWith(`${planned.task}__`));
  if (trials.length !== 1) {
    row.issues.push(`Expected one trial directory, found ${trials.length}`);
    return row;
  }
  const trial = join(jobs, trials[0]);
  const agent = join(trial, 'agent');
  row.trial = trial;
  try {
    const result = await json(join(trial, 'result.json'));
    row.exception = result.exception_info;
    row.reward = result.verifier_result?.rewards?.reward ?? null;
    row.agent_seconds = result.agent_execution?.finished_at
      ? (Date.parse(result.agent_execution.finished_at) - Date.parse(result.agent_execution.started_at)) / 1000 : null;
    row.wall_seconds = result.finished_at
      ? (Date.parse(result.finished_at) - Date.parse(result.started_at)) / 1000 : null;
    if (row.exception) row.issues.push(row.exception.exception_type);
  } catch (error) {
    row.issues.push(`Trial result: ${error.message}`);
  }
  const observer = join(agent, 'observer');
  const files = await list(observer);
  const ids = new Set(files.filter(name => /\.(stdout|stderr)$/.test(name))
    .map(name => name.replace(/\.(stdout|stderr)$/, '')));
  for (const name of files.filter(name => name.endsWith('.json'))) {
    try {
      const record = await json(join(observer, name));
      assert.equal(record.marker, 'JEV_CAPTURE_ONLY_V1');
      const [stdout, stderr] = await Promise.all(['stdout', 'stderr'].map(stream =>
        readFile(join(observer, `${record.id}.${stream}`))));
      ids.delete(record.id);
      row.raw.push({
        ...record, stdout_sha256: sha256(stdout), stderr_sha256: sha256(stderr),
        stdout: outputStats(record.command.join(' '), stdout),
        stderr: outputStats(record.command.join(' '), stderr),
      });
      if (!record.complete) row.issues.push(`Incomplete capture: ${record.id}`);
    } catch (error) {
      row.issues.push(`Capture ${name}: ${error.message}`);
    }
  }
  row.orphan_captures = [...ids];
  if (ids.size) row.issues.push(`${ids.size} captures lack parseable metadata`);
  try {
    const settings = await json(join(agent, 'eval-settings.json'));
    assert.equal(settings.mode, 'capture-only');
    assert.equal(settings.instructions, protocol.instructions);
    assert.equal(settings.pruning_enabled, false);
    assert.equal(settings.version, protocol.version);
    assert.equal(settings.model, protocol.model);
    const cliLines = (await readFile(join(agent, 'codex.txt'), 'utf8')).split('\n');
    row.cli_notices = cliLines.filter(line => line.trim() && !line.trimStart().startsWith('{'));
    const cli = events(cliLines.filter(line => line.trimStart().startsWith('{')).join('\n'));
    row.agent_errors = cli.filter(event => ['error', 'turn.failed'].includes(event.type));
    const turns = cli.filter(event => event.type === 'turn.completed');
    const messages = cli.filter(event => event.type === 'item.completed' && event.item.type === 'agent_message');
    row.final_answer = turns.length === 1 ? messages.at(-1)?.item.text ?? null : null;
    const sessions = await readdir(join(agent, 'sessions'), { recursive: true });
    const paths = sessions.filter(name => name.endsWith('.jsonl'));
    assert.equal(paths.length, 1, 'Expected one native session');
    const native = events(await readFile(join(agent, 'sessions', paths[0]), 'utf8'));
    const contexts = native.filter(event => event.type === 'turn_context');
    assert(contexts.length && contexts.every(event => event.payload.model === 'gpt-5.5'));
    const payloads = native.filter(event => event.type === 'response_item').map(event => event.payload);
    const visible = JSON.stringify(payloads);
    assertNoEvidenceLeak(visible, ['/opt/jev-eval/evidence', '/opt/jev-eval/private']);
    assert(!visible.includes('JEV_CAPTURE_ONLY_V1'), 'Capture metadata leaked into context');
    row.evidence_isolated = true;
    row.native = nativeOutputs(native);
    if (!files.length && row.native.shell.some(call => call.wrapped)) row.issues.push('Missing wrapper evidence');
    const total = native.filter(event => event.type === 'event_msg' &&
      event.payload.type === 'token_count' && event.payload.info).at(-1)?.payload.info.total_token_usage;
    if (total) row.native_usage = total;
    assert.equal(turns.length, 1, 'Expected one completed Codex turn');
    assert(total, 'Missing native usage');
    for (const key of ['input_tokens', 'cached_input_tokens', 'output_tokens']) {
      assert(Number.isInteger(turns[0].usage[key]) && turns[0].usage[key] >= 0);
      assert.equal(total[key], turns[0].usage[key], `Usage mismatch: ${key}`);
    }
    assert(total.cached_input_tokens <= total.input_tokens);
    row.usage = turns[0].usage;
    row.normalized_model_usd = (row.usage.input_tokens * 5 + row.usage.output_tokens * 30) / 1e6;
  } catch (error) {
    row.issues.push(`Native audit: ${error.message}`);
  }
  row.raw.sort((left, right) => left.started - right.started);
  return row;
}

export function summarize(rows) {
  return ['compile', 'pdf', 'dab'].map(family => {
    const group = rows.filter(row => row.family === family);
    const raw = group.flatMap(row => row.raw);
    const text = raw.map(record => record.stdout).filter(output => output.utf8);
    const sizes = text.map(output => output.tokens).sort((a, b) => a - b);
    const native = group.flatMap(row => row.native.outputs);
    const shell = group.flatMap(row => row.native.shell);
    const bands = Object.fromEntries(['<1000', '1000–5000', '>5000–10000', '>10000']
      .map(band => [band, text.filter(output => output.band === band).length]));
    return {
      family, attempts: group.length, issues: group.filter(row => row.issues.length).length,
      shell_starts: shell.length, wrapper_starts: shell.filter(call => call.wrapped).length,
      captures: raw.length, complete_captures: raw.filter(record => record.complete).length,
      non_utf8: raw.length - text.length, empty_stdout: text.filter(output => output.empty).length,
      stdout_bands: bands, mean_stdout_tokens: sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null,
      median_stdout_tokens: sizes.length ? (sizes[Math.floor((sizes.length - 1) / 2)] + sizes[Math.floor(sizes.length / 2)]) / 2 : null,
      p90_stdout_tokens: sizes.length ? sizes[Math.ceil(sizes.length * 0.9) - 1] : null,
      maximum_stdout_tokens: sizes.at(-1) ?? null,
      static_candidates: text.filter(output => output.candidate).length,
      document_outputs: text.filter(output => output.category === 'document').length,
      stdout_tokens: text.reduce((sum, output) => sum + output.tokens, 0),
      stderr_tokens: raw.reduce((sum, record) => sum + (record.stderr.tokens ?? 0), 0),
      native_shell_outputs: native.length,
      native_shell_tokens: native.reduce((sum, output) => sum + output.tokens, 0),
      native_truncated_outputs: native.filter(output => output.native_truncation).length,
      native_outputs_over_5000: native.filter(output => output.tokens > 5000).length,
      native_outputs_over_10000: native.filter(output => output.tokens > 10000).length,
      image_calls: group.reduce((sum, row) => sum + row.native.images.length, 0),
      complete_usage_trials: group.filter(row => row.usage).length,
      normalized_model_usd: group.filter(row => row.usage).reduce((sum, row) => sum + row.normalized_model_usd, 0),
    };
  });
}

async function main() {
  const root = resolve(process.argv[2]);
  const protocol = await json(join(root, 'protocol.json'));
  const planned = await json(join(root, 'rows.json'));
  const rows = [];
  for (const row of planned) rows.push(await auditTrial(root, row, protocol));
  const summary = summarize(rows);
  await writeFile(join(root, 'capture-audit.json'), JSON.stringify({ rows, summary }, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
