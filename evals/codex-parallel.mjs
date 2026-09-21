import assert from 'node:assert/strict';

export async function runConcurrent(items, concurrency, worker) {
  assert(Number.isInteger(concurrency) && concurrency > 0, 'Concurrency must be a positive integer');
  let next = 0;
  let stopped = false;
  const results = new Array(items.length);
  const errors = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!stopped && next < items.length) {
      const index = next++;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        stopped = true;
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new AggregateError(errors, 'Parallel evaluation stopped; active workers finished');
  return results;
}
