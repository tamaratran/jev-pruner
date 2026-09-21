import assert from 'node:assert/strict';

export function thresholdArms(value) {
  if (value === undefined) return { native: null, pruned: 10_000 };
  const thresholds = value.split(',').map(Number);
  assert(thresholds.length === 2 && new Set(thresholds).size === 2 &&
    thresholds.every(number => Number.isSafeInteger(number) && number > 0),
  'JEV_EVAL_THRESHOLDS must contain two distinct positive integer token counts');
  return Object.fromEntries(thresholds.map(number => [`tokens-${number}`, number]));
}
