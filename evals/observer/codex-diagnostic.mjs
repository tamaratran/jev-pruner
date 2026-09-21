import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cases, execute, repo } from '../codex-repair-workloads.mjs';
import { evidenceMarker, externalEvidenceDirectory } from './evidence-isolation.mjs';

const historicalSource = process.env.JEV_HISTORICAL_SOURCE_ROOT ??
  (process.env.JEV_EVAL_SUITE === 'historical' ? repo : undefined);
const historical = historicalSource
  ? await import(pathToFileURL(join(historicalSource, 'evals/codex-historical-workloads.mjs')).href)
  : undefined;
const collect = process.argv[2] === '--collect';
const name = process.argv[collect ? 3 : 2];
assert(Object.hasOwn(historical?.cases ?? cases, name));
assert(process.env.JEV_EVAL_CAPTURE_DIR);
const rawDirectory = await externalEvidenceDirectory(process.env.JEV_EVAL_CAPTURE_DIR);
await externalEvidenceDirectory(process.env.JEV_OBSERVER_CAPTURE_DIR);

if (collect) {
  const result = historical ? await historical.diagnostic(name, process.cwd())
    : await execute(`${cases[name].command} 2>&1`, process.cwd());
  const output = `${result.stdout}${result.stderr}\nExit status: ${result.code}\n`;
  await writeFile(join(rawDirectory, `${randomUUID()}.json`),
    JSON.stringify({ evidenceMarker, name, command: historical ? result.command : cases[name].command, ...result, output }, null, 2),
    { mode: 0o600 });
  process.stdout.write(output);
  process.exitCode = result.timedOut ? 124
    : process.env.JEV_EVAL_PRESERVE_EXIT === 'true' ? result.code ?? 1 : 0;
} else {
  const pruned = process.env.JEV_EVAL_ARM === 'pruned';
  assert(['pruned', 'native'].includes(process.env.JEV_EVAL_ARM));
  const child = spawn('node', [
    ...(pruned ? [
      '--import', join(repo, 'tests/fixtures/codex-observer.mjs'),
      join(process.env.JEV_CODEX_PLUGIN_ROOT, 'dist/codex/run.js'), '--', 'node',
    ] : []),
    fileURLToPath(import.meta.url), '--collect', name,
  ], { stdio: 'inherit' });
  child.on('error', error => { throw error; });
  child.on('close', code => { process.exitCode = code ?? 1; });
}
