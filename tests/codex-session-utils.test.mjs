import { describe, expect, it } from 'vitest';
import { commandOutput } from './fixtures/codex-transcript.mjs';

describe('Codex recorded output decoding', () => {
  it('separates native shell metadata from unchanged stdout and stderr', () => {
    const output = 'stderr: diagnostic\n  literal stdout  \nOutput:\n';
    expect(commandOutput({ output: `Chunk ID: abc\nWall time: 0.2 seconds\nProcess exited with code 0\nOriginal token count: 20\nOutput:\n${output}` }))
      .toBe(output);
  });

  it('preserves output from an intermediate running process result', () => {
    expect(commandOutput({ output: 'Chunk ID: abc\nWall time: 1 seconds\nProcess running with session ID 123\nOutput:\nstderr-first\n' }))
      .toBe('stderr-first\n');
  });

  it('extracts code-mode shell results while preserving truncation markers', () => {
    const output = '...100 tokens truncated...\nstdout\n';
    expect(commandOutput({ output: [
      { type: 'input_text', text: 'Script completed\nWall time 0.2 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ exit_code: 0, output }) },
    ] })).toBe(output);
    expect(commandOutput({ output: [{ type: 'input_text', text: 'unrecognized schema' }] })).toBeUndefined();
  });
});
