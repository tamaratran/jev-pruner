import { describe, expect, it } from 'vitest';
import { runConcurrent } from '../evals/codex-parallel.mjs';

describe('bounded Codex evaluation', () => {
  it('overlaps independent pairs while preserving arm order and the concurrency limit', async () => {
    let active = 0;
    let maximum = 0;
    const completed = [];
    const results = await runConcurrent([0, 1, 2, 3, 4], 2, async pair => {
      maximum = Math.max(maximum, ++active);
      for (const arm of ['first', 'second']) {
        await new Promise(resolve => setImmediate(resolve));
        completed.push(`${pair}-${arm}`);
      }
      active--;
      return pair;
    });
    expect(maximum).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4]);
    for (const pair of results) {
      expect(completed.indexOf(`${pair}-first`)).toBeLessThan(completed.indexOf(`${pair}-second`));
    }
  });

  it('stops scheduling on failure and waits for the other active worker', async () => {
    const started = [];
    const finished = [];
    await expect(runConcurrent([0, 1, 2, 3], 2, async pair => {
      started.push(pair);
      await new Promise(resolve => setImmediate(resolve));
      if (pair === 0) throw new Error('fixture failed');
      finished.push(pair);
    })).rejects.toThrow('active workers finished');
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });

  it('rejects invalid limits and handles an empty inventory', async () => {
    for (const concurrency of [0, -1, 1.5, NaN]) {
      await expect(runConcurrent([], concurrency, () => {})).rejects.toThrow('positive integer');
    }
    expect(await runConcurrent([], 32, () => {})).toEqual([]);
  });
});
