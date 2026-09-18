import { spawn } from 'node:child_process';
import { pruneCodexOutput } from './prune.js';

const args = process.argv.slice(2);
if (args[0] !== '--' || args.length < 2) {
  process.stderr.write('Usage: node run.js -- <executable> [arguments...]\n');
  process.exitCode = 2;
} else {
  const [command, ...parameters] = args.slice(1);
  const child = spawn(command, parameters, { stdio: ['inherit', 'pipe', 'inherit'] });
  const buffers: Buffer[] = [];
  const limit = 8 * 1024 * 1024;
  let bytes = 0;
  let streaming = false;
  let spawnFailed = false;
  const forwardInt = () => child.kill('SIGINT');
  const forwardTerm = () => child.kill('SIGTERM');
  process.on('SIGINT', forwardInt);
  process.on('SIGTERM', forwardTerm);
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (!streaming && bytes > limit) {
      streaming = true;
      for (const buffer of buffers) process.stdout.write(buffer);
      buffers.length = 0;
    }
    if (streaming) {
      if (!process.stdout.write(chunk)) child.stdout.pause();
    } else buffers.push(chunk);
  });
  process.stdout.on('drain', () => child.stdout.resume());
  child.on('error', () => {
    spawnFailed = true;
    process.stderr.write('jev-pruner: unable to start command\n');
    process.exitCode = 127;
  });
  child.on('close', async (code, signal) => {
    if (!streaming) {
      const output = Buffer.concat(buffers);
      const displayed = code === 0 && !signal
        ? await pruneCodexOutput(output, [command, ...parameters].join(' '), {
          cwd: process.cwd(),
          sessionId: process.env.CODEX_THREAD_ID,
          apiKey: process.env.TYPESAFE_API_KEY,
        })
        : output;
      process.stdout.write(displayed);
    }
    process.removeListener('SIGINT', forwardInt);
    process.removeListener('SIGTERM', forwardTerm);
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = spawnFailed ? 127 : code ?? 127;
  });
}
