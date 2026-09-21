import { describe, expect, it } from 'vitest';
import { auditHostPreview, hostPreviews } from '../evals/codex-preview.mjs';

describe('Codex host preview accounting', () => {
  it('preserves small outputs and rejects unmatched output', () => {
    expect(auditHostPreview('ok\n', 'ok\n', 100)).toBe(false);
    expect(() => auditHostPreview('wrong\n', 'ok\n', 100)).toThrow('does not match');
  });

  it('checks the exact prefix, suffix, marker, and optional line-count header', () => {
    const output = 'a'.repeat(30) + '\n' + 'b'.repeat(29);
    const expected = 'a'.repeat(10) + '…10 tokens truncated…' + 'b'.repeat(10);
    expect(hostPreviews(output, 5)).toEqual([expected, `Total output lines: 2\n\n${expected}`]);
    expect(auditHostPreview(expected, output, 5)).toBe(true);
    expect(() => auditHostPreview(expected.replace('10 tokens', '9 tokens'), output, 5)).toThrow();
    expect(() => auditHostPreview(expected.replace('a', 'c'), output, 5)).toThrow();
  });

  it('cuts only on UTF-8 boundaries', () => {
    const output = 'α'.repeat(20) + '😀'.repeat(20);
    for (const preview of hostPreviews(output, 5)) {
      expect(preview).not.toContain('\uFFFD');
      expect(auditHostPreview(preview, output, 5)).toBe(true);
    }
  });

  it('does not credit raw pruning that remains larger than the host preview', () => {
    const original = 'x'.repeat(1000);
    const delivered = 'x'.repeat(600);
    const visible = hostPreviews(delivered, 10)[1];
    const baseline = Math.min(...hostPreviews(original, 10).map(text => text.length));
    expect(visible.length < baseline).toBe(false);
  });
});
