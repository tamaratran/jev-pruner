import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { record } from './history.js';

export function contextPath(sessionId: string, home = homedir()): string {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId)) throw new Error('Invalid session id');
  return join(home, '.cache', 'jev-pruner', 'codex', `${sessionId}.json`);
}

export async function saveContext(input: unknown, home = homedir()): Promise<void> {
  const event = record(input);
  if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'Bash') return;
  if (typeof event.session_id !== 'string') throw new Error('Missing session id');
  const path = contextPath(event.session_id, home);
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const pending = `${path}.${randomUUID()}`;
  await writeFile(pending, JSON.stringify({
    sessionId: event.session_id,
    transcript: event.transcript_path,
  }), { mode: 0o600, flag: 'wx' });
  await rename(pending, path);
}

export async function readTranscript(sessionId: string, home = homedir()): Promise<string> {
  const context = record(JSON.parse(await readFile(contextPath(sessionId, home), 'utf8')));
  if (context.sessionId !== sessionId || typeof context.transcript !== 'string'
      || !isAbsolute(context.transcript)) throw new Error('Invalid transcript pointer');
  return readFile(context.transcript, 'utf8');
}
