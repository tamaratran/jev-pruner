import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const tsc = `node ${quote(join(repo, 'node_modules/typescript/bin/tsc'))}`;
export const cases = {
  build: {
    command: `${tsc} --listFiles --pretty false`,
    verify: `${tsc} --pretty false`,
    editable: ['src/config.ts'],
    evidence: ['src/config.ts', 'error TS2322', 'Exit status:'],
    question: 'Repair the TypeScript build and implement the timeout contract in README.md. Only edit src/config.ts.',
    solution: {
      'src/config.ts': 'export function resolveTimeout(value: string | undefined): number {\n'
        + '  const timeout = value === undefined ? 4500 : Number(value);\n'
        + '  if (!Number.isInteger(timeout) || timeout <= 0) throw new RangeError("invalid timeout");\n'
        + '  return timeout;\n}\n',
    },
  },
  test: {
    command: 'python3 -m pytest -vv --tb=line -p no:cacheprovider',
    verify: 'python3 -m pytest -q --tb=short -p no:cacheprovider',
    editable: ['cart.py'],
    evidence: ['test_percentage_discount', 'FAILED', 'Exit status: 1'],
    question: 'Repair the cart calculation so the tests and the discount contract in README.md hold. Only edit cart.py; do not edit tests.',
    solution: {
      'cart.py': 'def invoice_total(subtotal, discount_percent=0):\n'
        + '    if not 0 <= discount_percent <= 100:\n'
        + '        raise ValueError("invalid discount")\n'
        + '    return round(subtotal * (1 - discount_percent / 100), 2)\n',
    },
  },
  install: {
    command: 'npm install --offline --no-audit --no-fund --loglevel=silly --cache .npm-cache',
    verify: 'npm install --offline --no-audit --no-fund --loglevel=error --cache .npm-cache',
    editable: ['package.json', 'package-lock.json'],
    evidence: ['MODULE_NOT_FOUND', 'scripts/check-build.cjs', 'Exit status: 1'],
    question: 'Repair the npm install lifecycle using the checked-in runtime validator, preserving every dependency and lifecycle validation. Only edit package.json and package-lock.json. Do not bypass scripts.',
    solution: {},
  },
};

export async function execute(command, cwd, env = process.env, timeout = 180_000) {
  const started = Date.now();
  const child = spawn('bash', ['-c', command], { cwd, env, detached: true });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', data => stdout.push(data));
  child.stderr.on('data', data => stderr.push(data));
  child.stdin.end();
  let timedOut = false;
  const terminate = signal => {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  const timer = setTimeout(() => { timedOut = true; terminate('SIGTERM'); }, timeout);
  const force = setTimeout(() => terminate('SIGKILL'), timeout + 10_000);
  try {
    const code = await new Promise((done, fail) => {
      child.on('error', fail);
      child.on('close', done);
    });
    return {
      code, timedOut, seconds: (Date.now() - started) / 1000,
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(force);
  }
}

export async function prepare(name, directory) {
  const put = async (file, contents) => {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), contents);
  };
  if (name === 'build') {
    await put('README.md', '# Runtime timeout\n\nresolveTimeout accepts an optional string. '
      + 'When undefined it returns 4500 milliseconds. Otherwise convert a positive integer string '
      + 'to a number. Reject zero, negative, fractional, nonnumeric, and infinite values with RangeError.\n');
    await put('src/config.ts', 'export function resolveTimeout(value: string | undefined): number {\n'
      + '  return value ?? "4500";\n}\n');
    await put('tsconfig.json', JSON.stringify({
      compilerOptions: { target: 'ES2020', module: 'CommonJS', strict: true, outDir: 'dist', noEmitOnError: true },
      include: ['src'],
    }));
    for (let index = 0; index < 650; index += 1) {
      await put(`src/component_${String(index).padStart(4, '0')}.ts`, `export const component${index} = ${index};\n`);
    }
  } else if (name === 'test') {
    await put('README.md', '# Cart totals\n\ninvoice_total returns a subtotal after applying a '
      + 'percentage discount, rounded to two decimal places. A missing discount means zero percent. '
      + 'Discounts outside the inclusive range 0 to 100 must raise ValueError.\n');
    await put('cart.py', 'def invoice_total(subtotal, discount_percent=0):\n'
      + '    return round(subtotal - discount_percent, 2)\n');
    await put('test_cart.py', 'import pytest\nfrom cart import invoice_total\n\n'
      + '@pytest.mark.parametrize("subtotal", range(800))\n'
      + 'def test_regular_invoice_total(subtotal):\n    assert invoice_total(subtotal) == subtotal\n\n'
      + 'def test_percentage_discount():\n    assert invoice_total(240, 25) == 180\n');
  } else if (name === 'install') {
    const dependencies = {};
    for (let index = 0; index < 350; index += 1) {
      const dependency = `local-runtime-component-${String(index).padStart(3, '0')}`;
      dependencies[dependency] = `file:vendor/${dependency}`;
      await put(`vendor/${dependency}/package.json`, JSON.stringify({
        name: dependency, version: '1.0.0', main: 'index.cjs',
      }));
      await put(`vendor/${dependency}/index.cjs`, `module.exports = ${index};\n`);
    }
    await put('package.json', JSON.stringify({
      name: 'offline-runtime-install', version: '1.0.0', private: true,
      scripts: { postinstall: 'node scripts/check-build.cjs' }, dependencies,
    }, null, 2));
    await put('README.md', '# Runtime package\n\nInstall all local dependencies offline. '
      + 'The postinstall lifecycle must execute the checked-in scripts/check-runtime.cjs validator. '
      + 'Do not remove dependencies, disable scripts, or substitute the validation result.\n');
    await put('scripts/check-runtime.cjs',
      'const fs = require("node:fs");\nconst manifest = require("../package.json");\n'
      + 'const values = Object.keys(manifest.dependencies).map(name => require(name));\n'
      + 'if (values.length !== 350 || values.reduce((a,b) => a+b,0) !== 61075) throw new Error("invalid dependencies");\n'
      + 'fs.writeFileSync("installation-ok.json", JSON.stringify({count:350,total:61075}));\n'
      + 'console.log("Runtime validation completed: 350 dependencies");\n');
  } else {
    throw new Error(`Unknown workload: ${name}`);
  }
}

export async function knownRepair(name, directory) {
  if (name === 'install') {
    const path = join(directory, 'package.json');
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    manifest.scripts.postinstall = 'node scripts/check-runtime.cjs';
    await writeFile(path, JSON.stringify(manifest, null, 2));
  } else {
    for (const [file, content] of Object.entries(cases[name].solution)) {
      await writeFile(join(directory, file), content);
    }
  }
}

export async function grade(name, directory) {
  if (name === 'install') await rm(join(directory, 'installation-ok.json'), { force: true });
  const verification = await execute(cases[name].verify, directory);
  if (verification.code !== 0 || verification.timedOut) return { passed: false, verification };
  const oracle = name === 'build'
    ? `node -e ${quote(`const assert=require("node:assert/strict");const {resolveTimeout:f}=require("./dist/config.js");assert.equal(f(undefined),4500);for(const n of [1,95,3000,91234])assert.equal(f(String(n)),n);for(const s of ["0","-2","1.5","oops","Infinity"])assert.throws(()=>f(s),RangeError);`)}`
    : name === 'test'
      ? `python3 -c ${quote('from cart import invoice_total as f\n'
        + 'for subtotal in [0, 8.5, 73, 240, 1024.72]:\n'
        + ' for percent in [0, 5, 12.5, 25, 50, 100]:\n'
        + '  assert f(subtotal,percent) == round(subtotal*(1-percent/100),2)\n'
        + 'for percent in [-1, 101]:\n'
        + ' try: f(100,percent)\n'
        + ' except ValueError: pass\n'
        + ' else: raise AssertionError("invalid discount accepted")\n')}`
      : `node -e ${quote('const assert=require("node:assert/strict");'
        + 'const p=require("./package.json");assert.equal(Object.keys(p.dependencies).length,350);'
        + 'for(let i=0;i<350;i++){const n="local-runtime-component-"+String(i).padStart(3,"0");assert.equal(p.dependencies[n],"file:vendor/"+n);}'
        + 'assert.match(p.scripts.postinstall,/^node (\\.\\/)?scripts\\/check-runtime\\.cjs$/);'
        + 'assert.deepEqual(require("./installation-ok.json"),{count:350,total:61075});')}`;
  const semantic = await execute(oracle, directory);
  return { passed: semantic.code === 0 && !semantic.timedOut, verification, semantic };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2]);
  await mkdir(root, { mode: 0o700 });
  for (const name of Object.keys(cases)) {
    const directory = join(root, name);
    await prepare(name, directory);
    const baseline = await execute(`${cases[name].command} 2>&1`, directory);
    await writeFile(join(root, `${name}-initial.json`), JSON.stringify(baseline, null, 2));
    assert.notEqual(baseline.code, 0, `${name}: initial command must fail`);
    assert.equal((await grade(name, directory)).passed, false, `${name}: broken project accepted`);
    await knownRepair(name, directory);
    assert.equal((await grade(name, directory)).passed, true, `${name}: known repair rejected`);
    console.log(`${name}: ${baseline.stdout.length} characters; broken/repair oracle checks passed`);
  }
}
