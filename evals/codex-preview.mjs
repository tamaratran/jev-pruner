import assert from 'node:assert/strict';

export function hostPreviews(text, tokens) {
  assert(Number.isInteger(tokens) && tokens > 0);
  const bytes = Buffer.from(text);
  const budget = tokens * 4;
  if (bytes.length <= budget) return [text];
  let start = Math.floor(budget / 2);
  let end = bytes.length - (budget - start);
  while ((bytes[start] & 0xc0) === 0x80) start--;
  while ((bytes[end] & 0xc0) === 0x80) end++;
  const marker = `…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…`;
  const preview = bytes.subarray(0, start).toString() + marker + bytes.subarray(end).toString();
  const lines = text.split('\n').length - Number(text.endsWith('\n'));
  return [preview, `Total output lines: ${lines}\n\n${preview}`];
}

export function auditHostPreview(visible, delivered, tokens) {
  assert(hostPreviews(delivered, tokens).includes(visible),
    'Visible output does not match captured delivery or Codex host preview');
  return visible !== delivered;
}
