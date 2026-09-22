import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { externalEvidenceDirectory } from './observer/evidence-isolation.mjs';

const separator = process.argv.indexOf('--');
if (separator < 0 || !process.argv[separator + 1]) {
  throw new Error('Expected -- <executable> <arguments>');
}
const command = process.argv.slice(separator + 1);
const root = await externalEvidenceDirectory(
  process.env.JEV_BENCH_EVIDENCE_ROOT ?? '/opt/jev-eval/evidence',
);
await mkdir(root, { recursive: true, mode: 0o700 });
const id = randomUUID();
const record = {
  marker: 'JEV_CAPTURE_ONLY_V1', id, command, cwd: process.cwd(),
  thread: process.env.CODEX_THREAD_ID ?? null,
  started: Date.now(), complete: false,
};
const metadata = join(root, `${id}.json`);
await writeFile(metadata, JSON.stringify(record), { mode: 0o600 });
const stdout = createWriteStream(join(root, `${id}.stdout`), { mode: 0o600 });
const stderr = createWriteStream(join(root, `${id}.stderr`), { mode: 0o600 });
const child = spawn(command[0], command.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.pipe(stdout);
child.stdout.pipe(process.stdout);
child.stderr.pipe(stderr);
child.stderr.pipe(process.stderr);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', error => { record.error = error.message; });
child.on('close', async (code, signal) => {
  await Promise.all([finished(stdout), finished(stderr)]);
  const exitCode = record.error ? 127 : code ?? 127;
  Object.assign(record, {
    code: exitCode, signal, finished: Date.now(), complete: true,
  });
  await writeFile(metadata, JSON.stringify(record), { mode: 0o600 });
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exitCode = exitCode;
});
