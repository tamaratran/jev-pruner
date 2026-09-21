import assert from 'node:assert/strict';
import { test } from 'vitest';
import { outputStats, nativeOutputs, summarize } from '../evals/capture_audit.mjs';

test('size eligibility does not override document or binary preservation', () => {
  const document = outputStats('cat source.txt', Buffer.from('A reference fact.\n'.repeat(5000)));
  assert(document.tokens > 10000);
  assert.equal(document.category, 'document');
  assert.equal(document.candidate, false);
  assert.equal(outputStats('read', Buffer.from([0xff])).band, 'non-UTF-8');
  assert.equal(outputStats('true', Buffer.from('')).empty, true);
});

test('native accounting separates command starts from polling outputs and image calls', () => {
  const items = [
    { type: 'function_call', name: 'functions.exec_command', call_id: 'a',
      arguments: JSON.stringify({ cmd: 'node /opt/jev-eval/evals/capture_command.mjs -- make', max_output_tokens: 1000 }) },
    { type: 'function_call_output', call_id: 'a',
      output: 'Wall time: 1\nProcess running with session ID 42\nFinal output:\nBuilding\n' },
    { type: 'function_call', name: 'functions.write_stdin', call_id: 'b',
      arguments: JSON.stringify({ session_id: 42, chars: '', max_output_tokens: 500 }) },
    { type: 'function_call_output', call_id: 'b',
      output: 'Process exited with code 0\nFinal output:\nhead…200 tokens truncated…tail' },
    { type: 'function_call', name: 'images.view_image', call_id: 'c',
      arguments: JSON.stringify({ path: 'page.png' }) },
    { type: 'function_call_output', call_id: 'c', output: 'image attachment' },
  ];
  const native = nativeOutputs(items.map(payload => ({ type: 'response_item', payload })));
  assert.equal(native.shell.length, 1);
  assert.equal(native.shell[0].wrapped, true);
  assert.equal(native.outputs.length, 2);
  assert.equal(native.outputs[0].chars, 'Building\n'.length);
  assert.equal(native.outputs[1].native_truncation, true);
  assert.equal(native.images.length, 1);
});

test('incomplete captures remain in counts instead of becoming missing small outputs', () => {
  const raw = [{
    complete: false, stdout: outputStats('build', Buffer.from('')),
    stderr: outputStats('build', Buffer.from('error: failed')),
  }, {
    complete: true, stdout: outputStats('build', Buffer.from([0xff])),
    stderr: outputStats('build', Buffer.from('')),
  }];
  const [result] = summarize([{
    family: 'compile', issues: ['incomplete'], raw,
    native: { shell: [{ wrapped: true }], outputs: [], images: [] }, usage: null,
  }]);
  assert.equal(result.captures, 2);
  assert.equal(result.complete_captures, 1);
  assert.equal(result.empty_stdout, 1);
  assert.equal(result.non_utf8, 1);
  assert.equal(result.shell_starts, 1);
  assert.equal(result.complete_usage_trials, 0);
});
