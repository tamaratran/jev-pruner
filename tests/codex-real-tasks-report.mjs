import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert(process.argv[2], 'Usage: node tests/codex-real-tasks-report.mjs <evidence-directory>');
const directory = resolve(process.argv[2]);
const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const number = value => Number(value).toLocaleString('en-US', { maximumFractionDigits: 1 });

const sections = result.tasks.map(task => `
<section>
  <h2>${escape(task.name)}</h2>
  <div class="metrics">
    <div><b>${number(task.originalBytes)}</b>original bytes</div>
    <div><b>${number(task.prunedBytes)}</b>model-visible bytes</div>
    <div><b>${number(task.reduction)}%</b>reduction</div>
    <div><b>${number(task.jevRequests)}</b>Jev requests</div>
  </div>
  <p><strong>${task.passed ? 'PASS' : 'FAIL'}</strong>.
  Native answer: ${task.baseline.correct ? 'correct' : 'incorrect'};
  pruned answer: ${task.pruned.correct ? 'correct' : 'incorrect'}.
  All required source evidence retained: ${task.evidence.every(item => item.retained) ? 'yes' : 'no'}.
  Independently selected expected answer:</p>
  <pre>${escape(JSON.stringify(task.expected, null, 2))}</pre>
  <details><summary>Required evidence coverage</summary>
  <pre>${escape(JSON.stringify(task.evidence, null, 2))}</pre></details>
  <div class="answers">
    <div><h3>Codex without pruning</h3><pre>${escape(task.baseline.answer)}</pre></div>
    <div><h3>Codex with Jev pruning</h3><pre>${escape(task.pruned.answer)}</pre></div>
  </div>
  <p>Observed elapsed time: native ${number(task.baseline.durationMs / 1000)}s;
  pruned ${number(task.pruned.durationMs / 1000)}s. Codex input tokens:
  native ${number(task.baseline.usage.input_tokens)};
  pruned ${number(task.pruned.usage.input_tokens)}.</p>
  <details><summary>Executed wrapper command</summary><pre>${escape(task.pruned.command)}</pre></details>
  <div class="outputs">
    <div><h3>Original command output</h3><pre>${escape(task.original)}</pre></div>
    <div><h3>What Codex received</h3><pre>${escape(task.pruned.visible)}</pre></div>
  </div>
  <p>The archive matched the original output byte for byte.
  SHA-256: <code>${escape(task.archiveSha256)}</code></p>
</section>`).join('');

const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex real-task Jev comparison</title>
<style>
body{font:16px/1.6 system-ui,sans-serif;color:#202c3b;background:#f3f5f8;margin:0}
main{max-width:1180px;margin:40px auto;padding:0 24px}
section{background:#fff;border:1px solid #dbe1e8;border-radius:12px;padding:28px;margin:28px 0}
.metrics{display:flex;gap:28px;flex-wrap:wrap;margin:24px 0}.metrics div{font-size:13px;color:#516174}
.metrics b{display:block;font-size:25px;color:#202c3b}
.answers,.outputs{display:grid;grid-template-columns:1fr 1fr;gap:18px}
pre{font:13px/1.55 ui-monospace,monospace;white-space:pre-wrap;background:#f3f5f8;padding:16px;border-radius:8px}
.outputs pre{height:360px;overflow:auto;background:#172333;color:#e3edf7}
summary{cursor:pointer}code{overflow-wrap:anywhere}
@media(max-width:760px){.answers,.outputs{grid-template-columns:1fr}section{padding:18px}}
</style><main>
<h1>Codex with and without Jev pruning</h1>
<p><strong>${result.passed ? 'PASS' : 'FAILED / INCOMPLETE'}</strong>
${result.error ? ` — ${escape(result.error)}` : ''}</p>
<p>Three fresh, authenticated Codex CLI source-investigation tasks against real repository
search output. Each task ran once with native output and once through the installed plugin.
Neither prompt includes the expected answer. Both answers had to match independently selected
facts. These are source-analysis tasks, not implementation or bug-fix benchmarks. The pruned runs also required an
omission marker, no host truncation, extractive retained text, successful Jev responses, and
an exact local archive.</p>
<p><strong>Codex:</strong> ${escape(result.codex)} · <strong>Model:</strong>
${escape(result.model)} · <strong>Started:</strong> ${escape(result.started)}</p>
${sections}
<p>One run per condition and task, with native output first. Timing and Codex token counts are
observations rather than a cost or latency benchmark; Jev usage is separate. No implementation
tasks or general accuracy claim are covered by this comparison.</p>
<p>No API keys or authorization headers are included in this report.</p>
</main></html>`;
const path = join(directory, 'codex-real-tasks-report.html');
await writeFile(path, html, { mode: 0o600 });
console.log(path);
