import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const root = '/opt/jev-eval';
const env = { ...process.env };
delete env.TYPESAFE_API_KEY;
if (env.JEV_EVAL_ARM === 'plugin') {
  env.TYPESAFE_API_KEY = await readFile(`${root}/private/jev-key`, 'utf8');
}
const child = spawn('node', [
  '--import', `${root}/evals/codex_observer.mjs`,
  `${root}/dist/codex/run.js`, ...process.argv.slice(2),
], { stdio: 'inherit', env });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', () => { process.exitCode = 127; });
child.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 127;
});
