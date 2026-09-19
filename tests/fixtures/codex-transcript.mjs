export function commandOutput(payload) {
  if (typeof payload.output === 'string') {
    return payload.output.replace(
      /^Chunk ID: [^\n]+\nWall time: [^\n]+\nProcess (?:exited with code \d+|running with session ID [^\n]+)\n(?:Original token count: \d+\n)?(?:Final output|Output):\n/,
      '',
    );
  }
  if (!Array.isArray(payload.output)) return undefined;
  const outputs = [];
  for (const part of payload.output) {
    try {
      const value = JSON.parse(part.text);
      if (typeof value?.output === 'string') outputs.push(value.output);
    } catch {
      // Non-JSON blocks contain tool metadata.
    }
  }
  return outputs.length ? outputs.join('') : undefined;
}
