import { describe, expect, it } from 'vitest';
import { looksSecret, resolveHookConfig } from '../hooks/fast-jev-output.ts';

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
