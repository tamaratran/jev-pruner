import { saveContext } from './context.js';

try {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  await saveContext(JSON.parse(Buffer.concat(chunks).toString('utf8')));
} catch {
  // A context failure must not prevent Codex from executing the command.
}
process.stdout.write('{}\n');
