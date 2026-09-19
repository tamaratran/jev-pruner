import { describe, expect, it, vi } from 'vitest';
import { CODEX_ROUTER_JEV_MODEL, createCodexRouterAsker } from '../src/codex/router-asker.js';

describe('Codex Router Jev asker', () => {
  it('posts Decisions requests using only the caller capability', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => new Response(
      JSON.stringify({ answers: { keep: { noul: 0 } } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const asker = createCodexRouterAsker({
      baseUrl: 'http://127.0.0.1:4202',
      readSecret: async () => 'caller/secret',
      fetch,
    });
    const state = { history: ['tool output'] };
    const questions = { keep: { type: 'noul', instructions: 'keep it?' } as const };
    await expect(asker.ask(state, questions)).resolves.toMatchObject({ answers: { keep: { noul: 0 } } });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:4202/_codex-router/caller%2Fsecret/v1/decisions');
    expect(init?.headers).toEqual({ authorization: 'Bearer caller/secret', 'content-type': 'application/json' });
    expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ model: CODEX_ROUTER_JEV_MODEL, state, questions });
  });

  it('fails when the host capability is unavailable or the router rejects the request', async () => {
    const asker = createCodexRouterAsker({ readSecret: async () => { throw new Error('missing'); } });
    await expect(asker.ask('state', {})).rejects.toThrow('missing');
    const rejected = createCodexRouterAsker({
      readSecret: async () => 'caller',
      fetch: vi.fn(async () => new Response('nope', { status: 503 })),
    });
    await expect(rejected.ask('state', {})).rejects.toThrow('Jev request failed (503)');
  });

  it('cancels an in-flight router request when the wrapper is interrupted', async () => {
    const controller = new AbortController();
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      controller.abort();
    }));
    const asker = createCodexRouterAsker({
      readSecret: async () => 'caller',
      fetch,
      signal: controller.signal,
    });
    await expect(asker.ask('state', {})).rejects.toThrow('aborted');
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('refuses a non-loopback router URL before reading the caller capability', async () => {
    const readSecret = vi.fn(async () => 'caller');
    const fetch = vi.fn();
    const asker = createCodexRouterAsker({
      baseUrl: 'https://router.example.test',
      readSecret,
      fetch,
    });
    await expect(asker.ask('state', {})).rejects.toThrow('loopback');
    expect(readSecret).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
