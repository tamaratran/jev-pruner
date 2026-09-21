import { describe, expect, it } from 'vitest';
import { thresholdArms } from '../evals/codex-thresholds.mjs';

describe('threshold comparison configuration', () => {
  it('retains the existing native/pruned comparison by default', () => {
    expect(thresholdArms(undefined)).toEqual({ native: null, pruned: 10_000 });
  });

  it('maps threshold arms to explicit wrapper settings in the requested order', () => {
    expect(thresholdArms('10000,5000')).toEqual({ 'tokens-10000': 10_000, 'tokens-5000': 5_000 });
  });

  it.each(['', '5000', '0,5000', '-1,5000', '5000,5000', '5000,1.5', '5000,Infinity', '5000,nope', '1,2,3'])(
    'rejects invalid threshold plans: %s',
    value => expect(() => thresholdArms(value)).toThrow(),
  );
});
