import assert from 'node:assert/strict';
import { test } from 'vitest';
import { responseEvents, usageFrom } from '../evals/continuation_audit.mjs';

test('accounting uses completed SSE usage even with empty aggregate output', () => {
  const body = [
    'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"exec_command"}}',
    'data: {"type":"response.completed","response":{"output":[],"usage":{"input_tokens":900,"output_tokens":80}}}',
    'data: [DONE]',
  ].join('\r\n\r\n');
  const events = responseEvents(body);
  assert.equal(events.length, 2);
  assert.deepEqual(usageFrom(events), { input: 900, output: 80, cached: 0 });
});

test('missing or truncated completions never become zero-cost completed inference', () => {
  assert.equal(usageFrom(responseEvents('data: {"type":"response.completed"\n\n')), null);
  assert.equal(usageFrom([{ type: 'error' }]), null);
  assert.throws(() => usageFrom([{ type: 'response.completed', response: { usage: {} } }]), /Invalid/);
  const complete = { type: 'response.completed', response: { usage: { input_tokens: 0, output_tokens: 0 } } };
  assert.throws(() => usageFrom([complete, complete]), /More than one/);
});
