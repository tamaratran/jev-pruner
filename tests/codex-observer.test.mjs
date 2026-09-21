import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertNoEvidenceLeak, assertNoEvidenceStateLeak, evidenceMarker, externalEvidenceDirectory } from '../evals/observer/evidence-isolation.mjs';

const execute = promisify(execFile);
const directories = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(homedir(), 'jev-evidence-test-'));
  directories.push(root);
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  return { root, workspace };
}

describe('Codex evaluation evidence isolation', () => {
  it('keeps real observer captures out of broad repository searches', async () => {
    const { root, workspace } = await fixture();
    const captureDirectory = join(root, 'observer', 'jev');
    vi.spyOn(process.argv, 'at').mockReturnValue('observer-test');
    vi.stubEnv('JEV_OBSERVER_CAPTURE_DIR', captureDirectory);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"answers":{},"usage":{"input_tokens":12}}')));
    await import('./fixtures/codex-observer.mjs');
    await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST', body: JSON.stringify({ state: { history: 'def prompt: private scoring context' }, questions: {} }),
    });
    const files = await readdir(captureDirectory);
    expect(files).toHaveLength(1);
    const capture = JSON.parse(await readFile(join(captureDirectory, files[0]), 'utf8'));
    expect(capture.evidenceMarker).toBe(evidenceMarker);
    expect(capture.response.status).toBe(200);
    expect(capture.request.state.history).toContain('private scoring context');
    await writeFile(join(workspace, 'source.py'), 'def prompt(): pass\n');
    const result = await execute('rg', ['--hidden', '--no-ignore', '-n', 'def prompt', '.'], { cwd: workspace });
    expect(result.stdout).toBe('./source.py:1:def prompt(): pass\n');
    expect(() => assertNoEvidenceLeak(result.stdout, [join(root, 'observer')])).not.toThrow();
    expect(await readdir(workspace)).toEqual(['source.py']);
  });

  it('rejects in-workspace, relative, and symlinked capture destinations', async () => {
    const { root, workspace } = await fixture();
    await expect(externalEvidenceDirectory(join(workspace, 'captures'), workspace)).rejects.toThrow('outside');
    await expect(externalEvidenceDirectory(workspace, workspace)).rejects.toThrow('outside');
    await expect(externalEvidenceDirectory('captures', workspace)).rejects.toThrow('absolute');
    await expect(externalEvidenceDirectory(undefined, workspace)).rejects.toThrow('absolute');
    const alias = join(root, 'alias');
    await symlink(workspace, alias);
    await expect(externalEvidenceDirectory(alias, workspace)).rejects.toThrow('resolves inside');
  });

  it('captures a failed diagnostic externally and preserves its process status', async () => {
    const { root, workspace } = await fixture();
    const rawDirectory = join(root, 'observer', 'raw');
    const captureDirectory = join(root, 'observer', 'jev');
    await writeFile(join(workspace, 'tsconfig.json'), '{"files":["missing.ts"]}');
    const result = await execute(process.execPath, [
      resolve('evals/observer/codex-diagnostic.mjs'), '--collect', 'build',
    ], {
      cwd: workspace,
      env: {
        ...process.env, JEV_HISTORICAL_SOURCE_ROOT: '',
        JEV_EVAL_CAPTURE_DIR: rawDirectory, JEV_OBSERVER_CAPTURE_DIR: captureDirectory,
        JEV_EVAL_PRESERVE_EXIT: 'true',
      },
    }).catch(error => error);
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('Exit status: 2');
    const files = await readdir(rawDirectory);
    expect(files).toHaveLength(1);
    const record = JSON.parse(await readFile(join(rawDirectory, files[0]), 'utf8'));
    expect(record.output).toBe(result.stdout);
    expect(record.code).toBe(2);
    expect(record.evidenceMarker).toBe(evidenceMarker);
    expect(await readdir(workspace)).toEqual(['tsconfig.json']);
    expect(await readdir(captureDirectory)).toEqual([]);
  });

  it('captures pre-host delivery without changing stdout or failure status', async () => {
    const { root, workspace } = await fixture();
    const rawDirectory = join(root, 'observer', 'raw');
    const deliveredDirectory = join(root, 'observer', 'delivered');
    await writeFile(join(workspace, 'tsconfig.json'), '{"files":["missing.ts"]}');
    const result = await execute(process.execPath, [
      resolve('evals/observer/codex-diagnostic.mjs'), 'build',
    ], {
      cwd: workspace,
      env: {
        ...process.env, JEV_HISTORICAL_SOURCE_ROOT: '',
        JEV_EVAL_CAPTURE_DIR: rawDirectory,
        JEV_OBSERVER_CAPTURE_DIR: join(root, 'observer', 'jev'),
        JEV_EVAL_DELIVERED_DIR: deliveredDirectory,
        JEV_EVAL_PRESERVE_EXIT: 'true', JEV_EVAL_ARM: 'native',
      },
    }).catch(error => error);
    expect(result.code).toBe(2);
    const files = await readdir(deliveredDirectory);
    expect(files).toHaveLength(1);
    const delivery = JSON.parse(await readFile(join(deliveredDirectory, files[0]), 'utf8'));
    const raw = JSON.parse(await readFile(join(rawDirectory, (await readdir(rawDirectory))[0]), 'utf8'));
    expect(delivery.output).toBe(result.stdout);
    expect(delivery.output).toBe(raw.output);
    expect(delivery.code).toBe(2);
    expect(delivery.evidenceMarker).toBe(evidenceMarker);
    expect(await readdir(workspace)).toEqual(['tsconfig.json']);
  });

  it('detects captured JSON, nested history, and explicit evidence-path output', () => {
    const directory = resolve('outside-evidence');
    const capture = JSON.stringify({ evidenceMarker, request: { state: {} } });
    expect(() => assertNoEvidenceLeak(`captures/test.json:1:${capture}`, [directory])).toThrow('leaked');
    expect(() => assertNoEvidenceLeak(JSON.stringify({ history: [{ text: capture }] }), [directory])).toThrow('leaked');
    expect(() => assertNoEvidenceLeak(`${directory}/raw/file.json`, [directory])).toThrow('leaked');
    expect(() => assertNoEvidenceLeak('Normal diagnostic\nExit status: 1', [directory])).not.toThrow();
  });

  it('allows sandbox root metadata but rejects evidence in Jev tool history', () => {
    const directory = resolve('outside-evidence');
    const state = { history: [{ text: `<workspace_roots><root>${directory}</root></workspace_roots>` }], chunks: [] };
    expect(() => assertNoEvidenceStateLeak(state, [directory])).not.toThrow();
    expect(() => assertNoEvidenceStateLeak({
      ...state, history: [{ text: evidenceMarker }],
    }, [directory])).toThrow('leaked');
    for (const key of ['tool_results', 'tool_calls']) {
      expect(() => assertNoEvidenceStateLeak({
        ...state, history: [{ text: '', [key]: [{ result: `${directory}/file.json` }] }],
      }, [directory])).toThrow('leaked');
    }
    expect(() => assertNoEvidenceStateLeak({
      ...state, chunks: [{ text: `${directory}/file.json` }],
    }, [directory])).toThrow('leaked');
  });
});
