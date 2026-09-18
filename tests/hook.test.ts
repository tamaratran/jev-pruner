import { describe, expect, it } from 'vitest';
import { getApiKey, looksSecret, resolveHookConfig } from '../hooks/fast-jev-output.ts';

describe('hook configuration', () => {
  it('uses the documented defaults', () => {
    expect(resolveHookConfig({})).toMatchObject({
      minTokens: 10_000,
      chunkLines: 20,
      keepThreshold: 0.5,
      maxStateTokens: 25_000,
      model: 'jev-latest',
    });
  });

  it('can turn off pruning of engine-saved output', () => {
    expect(resolveHookConfig({ persistedOutputs: false }).persistedOutputs).toBe(false);
  });

  it('accepts option overrides', () => {
    expect(
      resolveHookConfig({
        apiKey: 'key',
        minTokens: 15_000,
        chunkLines: 5,
        keepThreshold: 0.8,
        maxStateTokens: 5_000,
        model: 'jev-custom',
      }),
    ).toEqual({
      apiKey: 'key',
      minTokens: 15_000,
      persistedOutputs: true,
      persistedMaxChars: 8000,
      chunkLines: 5,
      keepThreshold: 0.8,
      maxStateTokens: 5_000,
      model: 'jev-custom',
    });
  });
});

describe('secret detection', () => {
  it('detects credential-like commands and output', () => {
    expect(looksSecret('cat .env', '')).toBe(true);
    expect(looksSecret('printf value', 'api_key=secret-value')).toBe(true);
    expect(looksSecret('ls', 'src README.md')).toBe(false);
  });
});

describe('api key lookup', () => {
  const $ = (env: Record<string, string>, settings: Record<string, unknown> = {}) => ({
    env: { get: async (name: string) => env[name] },
    settings: { read: async () => settings },
  });

  it('prefers the plugin option, then TYPESAFE_API_KEY', async () => {
    expect(await getApiKey($({ TYPESAFE_API_KEY: 'from-env' }), { apiKey: 'from-option' } as never)).toBe('from-option');
    expect(await getApiKey($({ TYPESAFE_API_KEY: 'from-env' }), {} as never)).toBe('from-env');
  });

  it('falls back to EVAL_TYPESAFE_API_KEY, which is all an eval run gets', async () => {
    expect(await getApiKey($({ EVAL_TYPESAFE_API_KEY: 'from-eval' }), {} as never)).toBe('from-eval');
  });

  it('falls back to the settings env block, and is undefined with no key anywhere', async () => {
    expect(await getApiKey($({}, { env: { TYPESAFE_API_KEY: 'from-settings' } }), {} as never)).toBe('from-settings');
    expect(await getApiKey($({}), {} as never)).toBeUndefined();
  });
});

describe('archive failure', () => {
  it('keeps the trim when the workspace cannot be written to', () => {
    const marker = "[fast-jev-output trimmed 40 lines (900 chars); full output: .claude/fast-jev-output/bash-t1.txt (Read or grep it if needed)]";
    const fallback = marker.replaceAll(
      '; full output: .claude/fast-jev-output/bash-t1.txt (Read or grep it if needed)',
      '; not saved to disk, re-run the command if you need these lines',
    );
    expect(fallback).toBe('[fast-jev-output trimmed 40 lines (900 chars); not saved to disk, re-run the command if you need these lines]');
  });
});
