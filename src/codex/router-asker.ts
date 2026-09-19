import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JevAsker, JevQuestions, JevResponse, JevState } from '../jev.js';
import { parseJevResponse } from '../jev.js';

export const CODEX_ROUTER_JEV_MODEL = 'openrouter-decisions/jev-latest';

export interface CodexRouterAskerOptions {
  home?: string;
  baseUrl?: string;
  readSecret?: () => Promise<string>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function loopbackBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Codex Router URL must be a loopback HTTP URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname) ||
    url.username || url.password || url.search || url.hash
  ) {
    throw new Error('Codex Router URL must be a loopback HTTP URL');
  }
  return url.toString().replace(/\/$/, '');
}

/** Creates an asker using the host-owned Codex Router caller capability. */
export function createCodexRouterAsker(options: CodexRouterAskerOptions = {}): JevAsker {
  const readSecret = options.readSecret ?? (() => readFile(
    join(options.home ?? homedir(), '.codex', 'codex-router', 'caller-secret'), 'utf8',
  ));
  const request = options.fetch ?? globalThis.fetch;
  const configuredBaseUrl = options.baseUrl ?? 'http://127.0.0.1:4202';
  const timeoutMs = options.timeoutMs ?? 30_000;

  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const baseUrl = loopbackBaseUrl(configuredBaseUrl);
      const secret = (await readSecret()).trim();
      if (!secret) throw new Error('Codex Router caller secret is empty');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal?.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(cancel, timeoutMs);
      try {
        if (options.signal?.aborted) cancel();
        const response = await request(`${baseUrl}/_codex-router/${encodeURIComponent(secret)}/v1/decisions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secret}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: CODEX_ROUTER_JEV_MODEL, state, questions }),
          signal: controller.signal,
          redirect: 'error',
        });
        return parseJevResponse(response.status, response.ok, await response.text());
      } finally {
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', cancel);
      }
    },
  };
}
