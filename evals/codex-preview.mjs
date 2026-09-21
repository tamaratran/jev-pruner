import assert from 'node:assert/strict';

function truncate(text, tokens) {
  const bytes = Buffer.from(text);
  const budget = tokens * 4;
  if (bytes.length <= budget) return text;
  let start = Math.floor(budget / 2);
  let end = bytes.length - (budget - start);
  while ((bytes[start] & 0xc0) === 0x80) start--;
  while ((bytes[end] & 0xc0) === 0x80) end++;
  const marker = `…${Math.ceil((bytes.length - budget) / 4)} tokens truncated…`;
  return bytes.subarray(0, start).toString() + marker + bytes.subarray(end).toString();
}

export function hostPreviews(text, tokens) {
  assert(Number.isInteger(tokens) && tokens > 0);
  const bytes = Buffer.from(text);
  const cap = 1024 * 1024;
  if (bytes.length > cap) {
    const marker = `... ${bytes.length - cap} bytes omitted ...`;
    const capped = Buffer.concat([
      bytes.subarray(0, cap / 2), Buffer.from(`\n${marker}\n`),
      bytes.subarray(bytes.length - cap / 2),
    ]).toString();
    if (Buffer.byteLength(capped) <= tokens * 4) return [capped];
    const preview = truncate(capped, tokens);
    const notice = preview.includes(marker) ? '' : `${marker}\n`;
    return [`Warning: truncated output (original token count: ${Math.ceil(bytes.length / 4)})\n${notice}\n${preview}`];
  }
  const preview = truncate(text, tokens);
  if (preview === text) return [text];
  const lines = text.split('\n').length - Number(text.endsWith('\n'));
  return [preview, `Total output lines: ${lines}\n\n${preview}`];
}

export function auditHostPreview(visible, delivered, tokens) {
  assert(hostPreviews(delivered, tokens).includes(visible),
    'Visible output does not match captured delivery or Codex host preview');
  return visible !== delivered;
}
