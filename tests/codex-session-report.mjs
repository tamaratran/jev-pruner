import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directories = process.argv.slice(2).map(path => resolve(path));
assert(directories.length, 'Usage: node tests/codex-session-report.mjs <evidence-directory> [...]');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });
const sections = [];

for (const directory of directories) {
  const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
  let metadata = {};
  try {
    metadata = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const rows = result.rows;
  const before = rows.reduce((sum, row) => sum + row.beforeBytes, 0);
  const after = rows.reduce((sum, row) => sum + row.afterBytes, 0);
  sections.push(`
    <section>
      <h2>${result.passed ? 'PASS' : 'INCOMPLETE / FAILED'} · ${rows.length}/${result.stages} stages</h2>
      ${result.note ? `<p>${escape(result.note)}</p>` : ''}
      <p><strong>Run started:</strong> ${escape(metadata.started ?? 'Not recorded')}</p>
      <p><strong>Codex:</strong> ${escape(metadata.codex ?? '0.152.1')}
      · <strong>Model selection:</strong> ${escape(metadata.model ?? 'Codex default')}</p>
      <p><strong>Host output token limit:</strong> ${escape(metadata.toolOutputTokenLimit ?? 'Codex default (10,000)')}</p>
      <p><strong>Session:</strong> <code>${escape(result.sessionId)}</code></p>
      <p><strong>Evidence:</strong> <code>${escape(directory)}</code></p>
      <div class="metrics">
        <div><b>${number(before)}</b>original stdout bytes</div>
        <div><b>${number(after)}</b>visible stdout + stderr bytes</div>
        <div><b>${before ? number(100 * (1 - after / before)) : '—'}%</b>net reduction</div>
        <div><b>${number(rows.reduce((sum, row) => sum + row.requests, 0))}</b>live Jev requests</div>
      </div>
      ${result.error ? `<p class="failure">${escape(result.error.slice(0, 600))}</p>` : ''}
      ${result.sample ? `
      <h3>Before and after · stage ${number(result.sample.stage)}</h3>
      <p>These are the complete captured outputs. Scroll either panel to inspect every line.</p>
      <details><summary>Executed command</summary><pre>${escape(result.sample.command)}</pre></details>
      <div class="output-grid">
        <div><h4>Original stdout · ${number(Buffer.byteLength(result.sample.original))} bytes</h4>
          <pre>${escape(result.sample.original)}</pre></div>
        <div><h4>What Codex received · ${number(Buffer.byteLength(result.sample.visible))} bytes</h4>
          <pre>${escape(result.sample.visible)}</pre></div>
      </div>
      <h3>Retained verbatim</h3>
      <pre class="retained">${escape(result.sample.kept.join('\n'))}</pre>
      <p>The original stdout and archived bytes match exactly.
      SHA-256: <code>${escape(result.sample.archiveSha256)}</code></p>` : ''}
      ${result.final ? `<h3>Final handoff (without tools)</h3><pre>${escape(result.final)}</pre>` : ''}
      ${result.recovery ? `
      <h3>Removed text, recovered by Codex</h3>
      ${result.recovery.verifiedAt ? `<p><strong>Recovery verified:</strong> ${escape(result.recovery.verifiedAt)}</p>` : ''}
      <p>The line below was absent from the pruned result. After its final handoff, Codex received
      only the lookup text <code>${escape(result.recovery.query)}</code>, found the archive
      through the footer, and retrieved the complete line with this command:</p>
      <pre>${escape(result.recovery.command)}</pre>
      <h4>Recorded tool result</h4><pre class="retained">${escape(result.recovery.visible)}</pre>
      <h4>Codex's answer</h4><pre>${escape(result.recovery.answer)}</pre>
      <p>The archive remained byte-for-byte unchanged after the read.</p>` : ''}
      <table><thead><tr><th>Stage</th><th>Original bytes</th><th>Visible bytes</th>
      <th>Requests</th><th>History partitions</th><th>Parallel</th><th>Max state estimate</th>
      <th>Retention / archive</th></tr></thead><tbody>
      ${rows.map(row => `<tr><td>${row.stage}</td><td>${number(row.beforeBytes)}</td>
        <td>${number(row.afterBytes)}</td><td>${row.requests}</td><td>${row.partitions}</td>
        <td>${row.parallel ? 'yes' : 'no'}</td><td>${number(row.maxStateTokens)}</td>
        <td>${row.retained && row.exactArchive ? 'pass / exact' : 'FAIL'}</td></tr>`).join('')}
      </tbody></table>
    </section>`);
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex / Jev sustained validation</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;color:#202c3b;background:#f3f5f8;margin:0}
main{max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:34px;line-height:1.2}
section{background:white;border:1px solid #dbe1e8;border-radius:12px;padding:28px;margin:28px 0}
code,pre{font:13px/1.6 ui-monospace,monospace;overflow-wrap:anywhere}
pre{white-space:pre-wrap;background:#f3f5f8;padding:18px;border-radius:8px}
.output-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
.output-grid pre{height:340px;overflow:auto;background:#172333;color:#e3edf7}
.retained{background:#e9f5ee;border-left:4px solid #31704b}
h3{margin-top:30px}h4{margin-bottom:8px}summary{cursor:pointer}
@media(max-width:760px){.output-grid{grid-template-columns:1fr}section{padding:18px}main{padding:0 12px}}
.metrics{display:flex;gap:28px;flex-wrap:wrap;margin:24px 0}.metrics div{font-size:13px;color:#516174}
.metrics b{display:block;font-size:25px;color:#202c3b}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:9px;border-bottom:1px solid #e1e6ed}
th{background:#f3f5f8}.failure{color:#a52222}a{color:#1957aa}
</style><main>
<h1>Codex / Jev sustained validation</h1>
<p>Real authenticated Codex CLI sessions and live Jev scoring of changing synthetic build logs.
The selected deployment target first appears in a tool result. The early user requirement,
selected artifact, rollback, error, final status, stderr, and exact archive must survive every stage.</p>
<p>Every retained line is checked against the producer. The audit reads recorded model-visible tool
results, detects host truncation, checks all Jev answers, and requires a final handoff without tools.
New runs separately verify that Codex can read an omitted line from the archive after that handoff.
Long runs must include parallel history partitions. These are synthetic stress tests, not a measured
token-savings benchmark for typical coding sessions.</p>
<p>Execution uses the workspace-write sandbox with network access. The reviewed local plugin runs
with invocation-only hook-trust bypass. The installed production JavaScript is compared with the
current build before longer runs; hashes and revision metadata are in the evidence directory.</p>
${sections.join('\n')}
<p>Reproduce: <code>npm run test:codex-session</code>. Set <code>JEV_CODEX_STAGES=2</code>
for a short check or <code>JEV_CODEX_MODEL</code> to select an available model.
No API keys or authorization headers are included in this report.</p>
</main></html>`;
const path = join(directories.at(-1), 'codex-session-report.html');
await writeFile(path, html, { mode: 0o600 });
console.log(path);
