import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.keys(value).sort().map(key => [key, canonical(value[key])]),
  );
  return value;
}

export const fingerprint = value =>
  createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export const REQUEST_ID_FIELDS = [
  'session_id', 'thread_id', 'turn_id', 'root_turn_id', 'installation_id',
  'window_id', 'context_window_id', 'turn_started_at_unix_ms',
  'x-codex-installation-id', 'x-codex-window-id',
];

function without(object, keys) {
  return Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
}

export function initialRequest(body) {
  assert(body.model === 'gpt-5.5', 'Unexpected model');
  assert(typeof body.instructions === 'string' && body.instructions.length, 'Missing base instructions');
  assert(Array.isArray(body.input) && body.input.length, 'Missing initial messages');
  assert(Array.isArray(body.tools) && body.tools.length, 'Missing tool definitions');
  assert(body.reasoning?.effort === 'high', 'Unexpected reasoning effort');
  assert(!body.previous_response_id, 'Cannot start from an earlier response');
  assert(body.input.every(item => item.type === 'message' &&
    ['user', 'developer', 'system'].includes(item.role)), 'Not a fresh conversation');
  const { prompt_cache_key: cacheKey, ...request } = structuredClone(body);
  assert(cacheKey === undefined || typeof cacheKey === 'string', 'Invalid cache key');
  for (const item of request.input) {
    delete item.id;
    if (item.internal_chat_message_metadata_passthrough) {
      item.internal_chat_message_metadata_passthrough = without(
        item.internal_chat_message_metadata_passthrough, ['turn_id', 'create_time'],
      );
    }
  }
  if (request.client_metadata) {
    request.client_metadata = without(request.client_metadata, REQUEST_ID_FIELDS);
    const nested = request.client_metadata['x-codex-turn-metadata'];
    if (nested) request.client_metadata['x-codex-turn-metadata'] =
      JSON.stringify(canonical(without(JSON.parse(nested), REQUEST_ID_FIELDS)));
  }
  return canonical(request);
}

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function workspaceManifest(root) {
  assert(!['/', '/home', '/root'].includes(resolve(root)), 'Use a dedicated task workspace');
  const entries = [];
  async function walk(directory) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      const path = join(directory, name);
      const info = await lstat(join(root, path));
      const entry = { path, mode: info.mode & 0o7777 };
      if (info.isSymbolicLink()) {
        const link = await readlink(join(root, path));
        const target = await realpath(join(root, path)).catch(error => {
          if (error.code === 'ENOENT') return resolve(root, dirname(path), link);
          throw error;
        });
        assert(!relative(resolve(root), target).split('/').includes('..'),
          `Workspace symlink escapes the fingerprinted tree: ${path}`);
        entries.push({ ...entry, link });
      } else if (info.isDirectory()) {
        entries.push({ ...entry, directory: true });
        await walk(path);
      } else {
        assert(info.isFile(), `Unsupported starting file: ${path}`);
        entries.push({ ...entry, sha256: await fileHash(join(root, path)) });
      }
    }
  }
  await walk('');
  return entries;
}

export async function runtimeManifest(args, privateRoot) {
  const shell = command => execFileSync('/bin/sh', ['-ec', command], {
    encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024,
  }).trim();
  const packages = shell(
    'if command -v dpkg-query >/dev/null; then dpkg-query -W; ' +
    'elif command -v apk >/dev/null; then apk info -v; else exit 1; fi',
  ).split('\n').sort();
  const binaries = {};
  for (const name of ['node', 'codex', 'bash', 'sh', 'gcc', 'cc', 'make', 'python3']) {
    const path = shell(`command -v ${name} || true`);
    binaries[name] = path ? { path, sha256: await fileHash(path) } : null;
  }
  const home = process.env.CODEX_HOME;
  assert(home, 'Missing isolated CODEX_HOME');
  assert(!(await readdir(home)).some(name => ['sessions', 'skills', 'plugins', 'memories'].includes(name)),
    'Codex home must start without sessions, skills, plugins or memories');
  return {
    cwd: process.cwd(),
    workspace: await workspaceManifest(process.cwd()),
    os_release: await readFile('/etc/os-release', 'utf8'),
    architecture: shell('uname -m'),
    packages,
    python_packages: binaries.python3 ? JSON.parse(shell(
      "python3 -c 'import importlib.metadata as m, json; " +
      'print(json.dumps(sorted((d.metadata["Name"], d.version) for d in m.distributions())))' + "'",
    )) : null,
    npm_packages: shell('npm ls -g --depth=0 --json'),
    binaries,
    node: process.version,
    codex: shell('codex --version'),
    config_sha256: await fileHash(join(home, 'config.toml')),
    catalog_sha256: await fileHash(join(privateRoot, 'models.json')),
    uid: process.getuid(),
    gid: process.getgid(),
    cgroup_limits: Object.fromEntries(await Promise.all(
      ['cpu.max', 'memory.max', 'pids.max'].map(async name => [
        name, await readFile(`/sys/fs/cgroup/${name}`, 'utf8').catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }),
      ]),
    )),
    args,
    environment: Object.fromEntries(
      ['PATH', 'HOME', 'SHELL', 'LANG', 'LC_ALL', 'TZ', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS',
        'LDFLAGS', 'MAKEFLAGS', 'PYTHONPATH', 'NODE_OPTIONS'].map(key => [key, process.env[key] ?? null]),
    ),
  };
}
