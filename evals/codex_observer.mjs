import childProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { saveContext } from '../dist/codex/context.js';
import { externalEvidenceDirectory } from './observer/evidence-isolation.mjs';

const root = await externalEvidenceDirectory(
  process.env.JEV_BENCH_EVIDENCE_ROOT ?? '/opt/jev-eval/evidence',
);
const marker = 'JEV_EVAL_PRIVATE_EVIDENCE_V1';
const id = randomUUID();
await mkdir(root, { recursive: true, mode: 0o700 });
const record = {
  marker, id, cwd: process.cwd(), command: process.argv.slice(3),
  thread: process.env.CODEX_THREAD_ID, started: Date.now(),
};
const sessions = join(process.env.CODEX_HOME, 'sessions');
const paths = await readdir(sessions, { recursive: true });
const matching = paths.filter(path => path.endsWith(`-${record.thread}.jsonl`));
if (matching.length !== 1) throw new Error('Expected exactly one native transcript');
await saveContext({
  hook_event_name: 'PreToolUse', tool_name: 'Bash',
  session_id: record.thread, transcript_path: join(sessions, matching[0]),
});

const raw = createWriteStream(join(root, `${id}.raw`), { mode: 0o600 });
const delivered = createWriteStream(join(root, `${id}.delivered`), { mode: 0o600 });
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  delivered.write(chunk);
  return originalWrite(chunk, ...rest);
};
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  const child = originalSpawn(...args);
  child.stdout.on('data', chunk => raw.write(chunk));
  child.on('close', (code, signal) => {
    record.child_code = code;
    record.child_signal = signal;
    raw.end();
  });
  return child;
};
syncBuiltinESMExports();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, init);
  const capture = { marker, id, request: JSON.parse(init.body), started: Date.now() };
  try {
    const response = await originalFetch(url, init);
    capture.response = { status: response.status, body: await response.clone().text() };
    return response;
  } catch (error) {
    capture.error = error.message;
    throw error;
  } finally {
    capture.durationMs = Date.now() - capture.started;
    await writeFile(join(root, `${id}-jev-${randomUUID()}.json`), JSON.stringify(capture), { mode: 0o600 });
  }
};
process.on('beforeExit', async () => {
  if (!delivered.closed) await new Promise(resolve => delivered.end(resolve));
});
process.on('exit', code => {
  record.wrapper_code = code;
  record.finished = Date.now();
  const text = readFileSync(join(root, `${id}.delivered`), 'utf8');
  const archive = /\[fast-jev-output full output: (.+) \(Read or grep it if needed\)\]/.exec(text)?.[1];
  if (archive) {
    record.archive = archive;
    record.archive_exact = readFileSync(archive).equals(readFileSync(join(root, `${id}.raw`)));
  }
  writeFileSync(join(root, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
});
