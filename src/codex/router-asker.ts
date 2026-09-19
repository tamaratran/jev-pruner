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
}

/** Creates an asker using the host-owned Codex Router caller capability. */
export function createCodexRouterAsker(options: CodexRouterAskerOptions = {}): JevAsker {
  const readSecret = options.readSecret ?? (() => readFile(
    join(options.home ?? homedir(), '.codex', 'codex-router', 'caller-secret'), 'utf8',
  ));
  const request = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? 'http://127.0.0.1:4202').replace(/\/$/, '');

  return {
    async ask(state: JevState, questions: JevQuestions): Promise<JevResponse> {
      const secret = (await readSecret()).trim();
      if (!secret) throw new Error('Codex Router caller secret is empty');
      const response = await request(`${baseUrl}/_codex-router/${encodeURIComponent(secret)}/v1/decisions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: CODEX_ROUTER_JEV_MODEL, state, questions }),
      });
      return parseJevResponse(response.status, response.ok, await response.text());
    },
  };
}
