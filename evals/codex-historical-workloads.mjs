import assert from 'node:assert/strict';
import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execute, quote, repo } from './codex-repair-workloads.mjs';

export { execute, quote, repo };
const names = ['click', 'flask', 'pytest', 'pip', 'hatch'];
const definitions = join(repo, 'evals/historical');
export const cases = Object.fromEntries(await Promise.all(names.map(async name =>
  [name, JSON.parse(await readFile(join(definitions, name, 'case.json'), 'utf8'))])));
const cacheRoot = () => {
  assert(process.env.JEV_HISTORICAL_CACHE, 'Set JEV_HISTORICAL_CACHE to the prepared fixture cache.');
  return resolve(process.env.JEV_HISTORICAL_CACHE);
};
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});

export function testCounts(text) {
  const summary = text.trim().split('\n').findLast(line => /\d+ (passed|failed|error)/.test(line)) ?? '';
  return Object.fromEntries(['passed', 'failed', 'error', 'skipped', 'xfailed', 'deselected']
    .map(kind => [kind, Number(summary.match(new RegExp(`(\\d+) ${kind}(?:s)?\\b`))?.[1] ?? 0)]));
}

export async function diagnostic(name, cwd, verify = false) {
  const definition = cases[name];
  assert(definition, `Unknown case: ${name}`);
  const env = Object.fromEntries(Object.entries(definition.environment)
    .map(([key, value]) => [key, value.replaceAll('{workspace}', cwd)]));
  const python = join(cacheRoot(), name, 'venv/bin/python');
  const args = verify ? definition.verify_args : definition.diagnostic_args;
  const command = [python, ...args].map(quote).join(' ');
  return {
    command,
    ...await execute(`${command} 2>&1`, cwd, {
      ...process.env, ...env, PYTHONDONTWRITEBYTECODE: '1', PYTEST_ADDOPTS: '', NO_COLOR: '1',
    }, 180_000),
  };
}

export async function prepare(name, directory) {
  assert(!(await exists(directory)), `Workspace already exists: ${directory}`);
  await cp(join(cacheRoot(), name, 'baseline'), directory, { recursive: true });
}

export async function grade(name, workspace) {
  const directory = join(workspace, '..', 'oracle');
  await prepare(name, directory);
  for (const file of cases[name].editable) {
    const source = join(workspace, file);
    if (!(await exists(source)) || !(await lstat(source)).isFile()) {
      return { passed: false, error: `Allowed source is missing or not a regular file: ${file}` };
    }
    await cp(source, join(directory, file));
  }
  const result = await diagnostic(name, directory, true);
  const validation = JSON.parse(await readFile(join(cacheRoot(), name, 'validation.json'), 'utf8'));
  const counts = testCounts(result.stdout);
  return {
    passed: result.code === 0 && !result.timedOut &&
      JSON.stringify(counts) === JSON.stringify(validation.fixed_counts),
    counts, expected_counts: validation.fixed_counts, verification: result,
  };
}

export async function initialize() {
  await mkdir(cacheRoot(), { recursive: true, mode: 0o700 });
  for (const name of names) {
    const definition = cases[name];
    const root = join(cacheRoot(), name);
    assert(!(await exists(root)), `Fixture cache already exists: ${root}`);
    await mkdir(root);
    const upstream = join(root, 'upstream');
    const baseline = join(root, 'baseline');
    await mkdir(upstream);
    await mkdir(baseline);
    const fetched = await execute(`git init -q && git fetch --depth=2 ${quote(definition.repository + '.git')} ${quote(definition.fix_commit)}`, upstream);
    assert.equal(fetched.code, 0, fetched.stderr);
    const parent = await execute(`git rev-parse ${quote(definition.fix_commit + '^')}`, upstream);
    assert.equal(parent.stdout.trim(), definition.base_commit, 'Not the immediate upstream parent');
    const archive = await execute(`git archive ${quote(definition.base_commit)} | tar -x -C ${quote(baseline)}`, upstream);
    assert.equal(archive.code, 0, archive.stderr);
    const regression = await execute(`git apply ${quote(join(definitions, name, 'regression.patch'))}`, baseline);
    assert.equal(regression.code, 0, regression.stderr);
    const setup = await execute(`bash ${quote(join(definitions, name, 'setup.sh'))} ${quote(baseline)} ${quote(join(root, 'venv'))}`, repo);
    await save(join(root, 'setup.json'), setup);
    assert.equal(setup.code, 0, setup.stderr);
    const broken = join(root, 'broken-check');
    await prepare(name, broken);
    const base = await diagnostic(name, broken);
    await save(join(root, 'base.json'), base);
    assert.equal(base.code, 1, base.stdout + base.stderr);
    assert(definition.evidence.every(fact => base.stdout.includes(fact)),
      `${name}: expected failure fact missing: ${definition.evidence.filter(fact => !base.stdout.includes(fact)).join('; ')}`);
    const fixed = join(root, 'fixed-check');
    await prepare(name, fixed);
    const repair = await execute(`git apply ${quote(join(definitions, name, 'repair.patch'))}`, fixed);
    assert.equal(repair.code, 0, repair.stderr);
    const diagnosticFixed = await diagnostic(name, fixed);
    const verified = await diagnostic(name, fixed, true);
    assert.equal(diagnosticFixed.code, 0, diagnosticFixed.stdout + diagnosticFixed.stderr);
    assert.equal(verified.code, 0, verified.stdout + verified.stderr);
    const validation = {
      name, repository: definition.repository, base_commit: definition.base_commit,
      fix_commit: definition.fix_commit, base,
      diagnostic_fixed: diagnosticFixed, verified,
      base_counts: testCounts(base.stdout), fixed_counts: testCounts(verified.stdout),
      dependencies: (await execute(`${quote(join(root, 'venv/bin/python'))} -m pip freeze --all`, root)).stdout,
    };
    await save(join(root, 'validation.json'), validation);
    console.log(`${name}: base=${base.code}, fixed=${verified.code}, chars=${base.stdout.length}, tests=${JSON.stringify(validation.fixed_counts)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await initialize();
}
