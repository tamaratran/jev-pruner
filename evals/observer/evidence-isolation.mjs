import assert from 'node:assert/strict';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const evidenceMarker = 'JEV_EVAL_PRIVATE_EVIDENCE_V1';

export async function externalEvidenceDirectory(directory, workspace = process.cwd()) {
  assert(directory && isAbsolute(directory), 'Evidence directory must be absolute');
  const root = await realpath(workspace);
  const outside = path => {
    const child = relative(root, path);
    return child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child);
  };
  assert(outside(resolve(directory)), 'Evidence directory must be outside the workspace');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const canonical = await realpath(directory);
  assert(outside(canonical), 'Evidence directory resolves inside the workspace');
  return canonical;
}

export function assertNoEvidenceLeak(text, directories) {
  assert(!text.includes(evidenceMarker) && !directories.some(directory => text.includes(directory)),
    'Evaluation evidence leaked into model-visible context');
}
