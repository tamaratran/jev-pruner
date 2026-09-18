import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Block {
  type: string;
  id?: string;
  name?: string;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  input?: { command?: string; file_path?: string };
}

interface Event {
  type: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content: Block[] };
}

interface Capture {
  request: { state: { chunks: { id: string; text: string }[] } };
  response: { status: number };
}

assert(process.env.TYPESAFE_API_KEY, 'Set TYPESAFE_API_KEY before running this billable test.');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(process.env.JEV_LONG_SESSION_DIR ?? join(homedir(), 'jev-long-sessions'));
mkdirSync(root, { recursive: true });
const workspace = mkdtempSync(join(root, 'recovery-'));
const command = `node -e 'const {randomUUID}=require("node:crypto"); const lines=Array.from({length:200},(_,i)=>"progress: module "+i+" cache already current "+"unchanged ".repeat(55)); lines[88]="progress: module 88 cache hash "+randomUUID(); lines[199]="Build succeeded."; console.log(lines.join("\\n"));'`;

function run(prompt: string, label: string, sessionId?: string): Event[] {
  const args = [
    '-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    '--max-budget-usd', '2', '--tools', 'Bash,Read', '--allowedTools', 'Bash(node -e:*)', 'Read',
    '--plugin-dir', repo, '--plugin-dir', join(repo, 'tests/fixtures/long-session-observer'),
    '--setting-sources', '', '--strict-mcp-config',
  ];
  if (sessionId) args.push('--resume', sessionId);
  const child = spawnSync('claude', args, {
    cwd: workspace, env: { ...process.env, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' },
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert(!child.stdout.includes(process.env.TYPESAFE_API_KEY!));
  writeFileSync(join(workspace, `${label}-events.jsonl`), child.stdout);
  assert.equal(child.status, 0, `Claude failed during ${label}`);
  const events = child.stdout.trim().split('\n').map(line => JSON.parse(line) as Event);
  assert(events.some(event => event.type === 'result' && !event.is_error));
  return events;
}

console.log(`Evidence directory: ${workspace}`);
const first = run(
  `Run exactly this Bash command once and report only whether the build succeeded. Do not run other commands or read files.\n${command}`,
  'build',
);
const firstBlocks = first.flatMap(event => event.message?.content ?? []);
const firstCalls = firstBlocks.filter(block => block.type === 'tool_use');
assert.equal(firstCalls.length, 1);
assert.equal(firstCalls[0]!.name, 'Bash');
assert.equal(firstCalls[0]!.input?.command, command);
const output = firstBlocks.find(block => block.type === 'tool_result');
assert(output && !output.is_error && typeof output.content === 'string');
const relative = output.content.match(/\[fast-jev-output full output: ([^\n]+) \(Read or grep it if needed\)\]$/)?.[1];
assert(relative, 'Compacted result did not end in its archive reference');
const archivePath = resolve(workspace, relative);
const archive = readFileSync(archivePath, 'utf8');
const evidence = join(workspace, '.claude/jev-long-session-evidence');
const requests = readdirSync(evidence).filter(name => name.startsWith('request-'));
assert(requests.length > 0);
const captures = requests.map(file => JSON.parse(readFileSync(join(evidence, file), 'utf8')) as Capture);
assert(captures.every(capture => capture.response.status === 200));
const chunks = [...new Map(captures.flatMap(capture =>
  capture.request.state.chunks.map(chunk => [chunk.id, chunk] as const))).values()]
  .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
assert.equal(archive, chunks.map(chunk => chunk.text).join('\n'));
const hash = archive.match(/progress: module 88 cache hash ([a-f0-9-]+)/)?.[1];
assert(hash);
assert(!output.content.includes(hash), 'Recovery value was already visible');
assert(output.content.includes('Build succeeded.'));
const sessionId = first.find(event => event.session_id)?.session_id;
assert(sessionId);
const recovery = run(
  'Now retrieve the exact cached hash for module 88 from the full-output file referenced at the end of the previous Bash result. Read that file exactly once with Read, then reply with only the hash. Do not rerun the build or use Bash.',
  'recovery',
  sessionId,
);
const recoveryBlocks = recovery.flatMap(event => event.message?.content ?? []);
assert(recovery.every(event => !event.session_id || event.session_id === sessionId));
const recoveryCalls = recoveryBlocks.filter(block => block.type === 'tool_use');
assert.equal(recoveryCalls.length, 1);
assert.equal(recoveryCalls[0]!.name, 'Read');
assert.equal(resolve(workspace, recoveryCalls[0]!.input?.file_path ?? ''), archivePath);
assert(recoveryBlocks.some(block => block.type === 'tool_result' && !block.is_error && block.content?.includes(hash)));
const final = recovery.filter(event => event.type === 'result').at(-1)?.result;
assert(final?.includes(hash));
const summary = {
  passed: true, sessionId, archivePath: relative, hash,
  originalChars: archive.length, visibleChars: output.content.length,
  valueWasAbsentFromCompactedResult: true, recoveredUsing: 'Read', final,
};
writeFileSync(join(workspace, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
