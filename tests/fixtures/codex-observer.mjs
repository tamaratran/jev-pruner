import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { evidenceMarker, externalEvidenceDirectory } from '../../evals/observer/evidence-isolation.mjs';

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url) !== 'https://api.typesafe.ai/v1/systemone') return originalFetch(url, init);
  const started = Date.now();
  const request = JSON.parse(init.body);
  const directory = process.env.JEV_OBSERVER_CAPTURE_DIR
    ? await externalEvidenceDirectory(process.env.JEV_OBSERVER_CAPTURE_DIR)
    : join(process.cwd(), 'captures');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${process.argv.at(-1)}-${randomUUID()}.json`);
  const capture = { evidenceMarker, request, started };
  try {
    const response = await originalFetch(url, init);
    capture.response = { status: response.status, body: await response.clone().text() };
    return response;
  } catch (error) {
    capture.error = error.message;
    throw error;
  } finally {
    capture.durationMs = Date.now() - started;
    await writeFile(path, JSON.stringify(capture), { mode: 0o600 });
  }
};
