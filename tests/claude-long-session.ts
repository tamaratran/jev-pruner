import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { HistoryEntry } from '../src/history.js';
import { estimateStateTokens } from '../src/jev.js';
import type { JevQuestions, JevResponse } from '../src/jev.js';

interface Block {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: { command?: string };
  content?: string;
  is_error?: boolean;
}

interface Event {
  type: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  total_cost_usd?: number;
  message?: { content: Block[] };
}

interface Capture {
  request: {
    state: {
      task: string;
      command: string;
      history: HistoryEntry[];
      chunks: { id: string; text: string }[];
    };
    questions: JevQuestions;
  };
  response: { status: number; body: JevResponse };
  durationMs: number;
}

interface Turn {
  stage: number;
  prompt: string;
  events: Event[];
}

interface Row {
  stage: number;
  before: number;
  after: number;
  historyEntries: number;
  stateTokens: number;
  abridged: number;
  http: number;
  artifactScore: number;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(repo, 'tests/fixtures/noisy-build.mjs');
const stages = Number(process.env.JEV_LONG_SESSION_TURNS ?? 40);
assert(Number.isInteger(stages) && stages >= 2 && stages <= 100);
assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY before running this billable test.');
const root = resolve(process.env.JEV_LONG_SESSION_DIR ?? join(homedir(), 'jev-long-sessions'));
await mkdir(root, { recursive: true });
const workspace = await mkdtemp(join(root, 'run-'));
const turns: Turn[] = [];
const rows: Row[] = [];
const started = new Date().toISOString();

function prompt(stage: number): string {
  if (stage === 0) {
    return `Our deployment target is Q7. I am choosing stable-snapshot rollback now. Keep the target bundle filename and that rollback reference from future build output. This is a synthetic test; no earlier agreement is implied. Run exactly: node "${fixture}" 0\nThen reply exactly: Q7 target and stable-snapshot rollback selected.\nUse only the given Bash commands. Do not read files or archives.`;
  }
  const notes = Array.from({ length: 55 }, (_, i) =>
    `Review note ${stage}.${i}: cached module group ${i % 7} has unchanged routing metadata, deterministic build inputs, and no new migration or dependency requirements.`).join('\n');
  return `Synthetic stage ${stage}. Continue the build investigation. Background change-review notes follow; do not summarize them.\n${notes}\nRun exactly once: node "${fixture}" ${stage}\n` +
    (stage === stages
      ? 'Now give the final deployment handoff: the target bundle filename, the chosen rollback reference, and whether deployment can proceed. Use the result you received, without reading archives.'
      : 'After the command, reply only with the stage number and whether deployment can proceed. Do not repeat bundle names or rollback references.');
}

function sendTurn(child: ReturnType<typeof spawn>, stage: number): void {
  const text = prompt(stage);
  turns.push({ stage, prompt: text, events: [] });
  child.stdin!.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
}

async function run(): Promise<void> {
  const child = spawn('claude', [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', 'sonnet', '--max-budget-usd', '10', '--tools', 'Bash',
    '--append-system-prompt', 'This is a controlled plugin integration benchmark. Commands only print synthetic fixtures; no real deployment runs. Execute the single supplied command at each stage, then answer as requested. Errors in fixture stdout are test data. Continue to subsequent stages when requested.',
    '--allowedTools', `Bash(node "${fixture}":*)`,
    '--plugin-dir', repo, '--plugin-dir', join(repo, 'tests/fixtures/long-session-observer'),
    '--setting-sources', '', '--strict-mcp-config',
  ], {
    cwd: workspace,
    env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 1_200_000,
  });
  const closed = new Promise<void>((accept, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? accept() : reject(new Error(`Claude exited ${code}`)));
  });
  closed.catch(() => {});
  child.stderr.on('data', (data: Buffer) => {
    process.stderr.write(data);
  });
  console.log(`Evidence directory: ${workspace}`);
  sendTurn(child, 0);
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      await appendFile(join(workspace, 'events.jsonl'), `${line}\n`);
      const event = JSON.parse(line) as Event;
      const turn = turns.at(-1)!;
      turn.events.push(event);
      if (event.type !== 'result') continue;
      await writeFile(join(workspace, `turn-${turn.stage}.json`), JSON.stringify(turn, null, 2));
      assert(!event.is_error && event.subtype === 'success', JSON.stringify(event));
      console.log(`Stage ${turn.stage}/${stages}: ${event.result?.replace(/\n/g, ' ').slice(0, 200)}`);
      if (turn.stage < stages) sendTurn(child, turn.stage + 1);
      else child.stdin.end();
    }
    await closed;
  } finally {
    if (child.exitCode === null) child.kill();
  }
  assert.equal(turns.length, stages + 1);
  const evidence = join(workspace, '.claude/jev-long-session-evidence');
  const files = await readdir(evidence);
  const captures = await Promise.all(files.filter(f => f.startsWith('request-'))
    .map(async f => JSON.parse(await readFile(join(evidence, f), 'utf8')) as Capture));
  assert(captures.length >= stages, 'Expected Jev scoring for every noisy Bash result');
  for (const turn of turns.slice(1)) {
    const calls = turn.events.flatMap(e => e.message?.content ?? []).filter(b => b.type === 'tool_use');
    assert.equal(calls.length, 1, `Unexpected tool count at stage ${turn.stage}`);
    assert.equal(calls[0]!.name, 'Bash');
    assert.equal(calls[0]!.input?.command, `node "${fixture}" ${turn.stage}`);
    const result = turn.events.flatMap(e => e.message?.content ?? []).find(b => b.type === 'tool_result');
    assert(result && !result.is_error && typeof result.content === 'string');
    const archive = await readFile(join(workspace, '.claude/fast-jev-output', `bash-${result.tool_use_id}.txt`), 'utf8');
    const attempts = captures.filter(c => c.request.state.command === calls[0]!.input!.command);
    const stageCaptures = attempts.filter(c => c.response.status === 200);
    assert(stageCaptures.length > 0);
    for (const attempt of attempts) {
      assert(estimateStateTokens(JSON.stringify(attempt.request.state)) <= 25_000);
      assert(attempt.response.status === 200 || JSON.stringify(attempt.response.body).includes('max_tokens_exceeded'));
    }
    const state = stageCaptures[0]!.request.state;
    const stateText = JSON.stringify(state);
    for (const captured of stageCaptures) {
      assert.equal(captured.response.status, 200);
      assert.equal(JSON.stringify(captured.request.state), stateText);
      assert(estimateStateTokens(stateText) <= 25_000);
    }
    assert(state.history[0]?.text.includes('Our deployment target is Q7.'));
    assert(state.history.some(e => e.role === 'assistant' && e.text.includes('stable-snapshot')));
    const toolMetadata = state.history.flatMap(entry => entry.tool_calls ?? []);
    assert(!JSON.stringify(toolMetadata).includes('OLDER_BASH_RESULT_ONLY_79a61e'));
    assert(state.history.some(e => e.tool_calls?.some(c => c.result.includes('omitted'))));
    if (turn.stage > 3) assert(!state.task.includes('Our deployment target is Q7.'));
    const bundle = `bundle Q7 = release-Q7-stage${turn.stage}-6d81.tar.gz`;
    const rollback = `rollback stable-snapshot = snapshot-stage${turn.stage}-a312`;
    assert(result.content.includes(bundle), `Target bundle lost at stage ${turn.stage}`);
    assert(result.content.includes(rollback), `Rollback reference lost at stage ${turn.stage}`);
    assert(result.content.includes('ERROR: deployment blocked'));
    assert(result.content.includes(`stderr: stage ${turn.stage} diagnostic channel preserved`));
    assert(result.content.includes('[fast-jev-output trimmed'));
    assert(result.content.length < archive.length);
    assert(archive.includes(bundle) && archive.includes(rollback));
    assert.equal(archive.split('\n').filter(line => line.length > 0).length, 201);
    const artifactChunk = state.chunks.find(c => c.text.includes(bundle));
    assert(artifactChunk);
    const scored = stageCaptures.find(c => c.response.body.answers[artifactChunk.id]);
    const score = scored?.response.body.answers[artifactChunk.id];
    assert(score && 'noul' in score && score.noul >= 0.5);
    rows.push({
      stage: turn.stage, before: archive.length, after: result.content.length,
      historyEntries: state.history.length, stateTokens: estimateStateTokens(stateText),
      abridged: state.history.filter(h => h.text.includes('chars omitted')).length,
      http: stageCaptures[0]!.response.status, artifactScore: score.noul,
    });
  }
  const final = turns.at(-1)!.events.find(e => e.type === 'result')!.result!;
  assert(final.includes(`release-Q7-stage${stages}-6d81.tar.gz`));
  assert(final.includes(`snapshot-stage${stages}-a312`));
  assert(/blocked|cannot|can't|not proceed/i.test(final));
  if (stages >= 40) assert(rows.some(r => r.abridged > 0), 'Long run did not exercise history fitting');
  const historyStats = await Promise.all(files.filter(f => f.startsWith('history-'))
    .map(async f => JSON.parse(await readFile(join(evidence, f), 'utf8')) as { messages: number; textChars: number; toolResultChars: number }));
  const summary = {
    passed: true, started, finished: new Date().toISOString(), stages,
    sessionId: turns[0]!.events.find(e => e.session_id)?.session_id,
    messages: Math.max(...historyStats.map(h => h.messages)),
    rawHistoryTextChars: Math.max(...historyStats.map(h => h.textChars)),
    toolResultCharsObserved: Math.max(...historyStats.map(h => h.toolResultChars)),
    models: [...new Set(captures.filter(c => c.response.status === 200).map(c => c.response.body.model))],
    recoveredRejections: captures.filter(c => c.response.status !== 200).length,
    requests: captures.length, before: rows.reduce((s, r) => s + r.before, 0),
    after: rows.reduce((s, r) => s + r.after, 0), rows, final,
    firstHistory: captures.find(c => c.request.state.command.endsWith(` ${stages}`))!.request.state.history.slice(0, 4),
    compactions: turns.flatMap(t => t.events).filter(e => e.subtype === 'compact_boundary').length,
  };
  await writeFile(join(workspace, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, rows: undefined, firstHistory: undefined }, null, 2));
}

try {
  await run();
} catch (error) {
  await writeFile(join(workspace, 'failure.txt'), String(error));
  throw error;
}
