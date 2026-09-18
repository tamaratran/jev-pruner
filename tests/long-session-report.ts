import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HistoryEntry } from '../src/history.js';

interface Summary {
  passed: boolean;
  errors: string[];
  started: string;
  finished: string;
  stages: number;
  sessionId: string;
  messages: number;
  rawHistoryTextChars: number;
  toolResultCharsObserved: number;
  models: string[];
  recoveredRejections: number;
  requests: number;
  before: number;
  after: number;
  rows: {
    stage: number;
    before: number;
    after: number;
    historyEntries: number;
    stateTokens: number;
    abridged: number;
    http: number;
    artifactScore: number;
    rollbackScore: number;
    artifactKept: boolean;
    rollbackKept: boolean;
    stderrScored: boolean;
  }[];
  final: string;
  firstHistory: HistoryEntry[];
  compactions: number;
}

interface SavedTurn {
  prompt: string;
  events: {
    type: string;
    message?: { content: { type: string; content?: string }[] };
  }[];
}

interface Replay {
  stage: number;
  variant: string;
  artifact: { noul: number };
  rollback: { noul: number };
}

interface ChunkReplay {
  stage: number;
  chunkLines: number;
  wording: string;
  artifactScore: number;
  rollbackScore: number;
  requests: number;
  durationMs: number;
  inputTokens: number;
}

assert(process.argv[2], 'Pass the evidence directory printed by test:long-session.');
const directory = resolve(process.argv[2]);
const summary = JSON.parse(await readFile(join(directory, 'summary.json'), 'utf8')) as Summary;
const finalTurn = JSON.parse(await readFile(join(directory, `turn-${summary.stages}.json`), 'utf8')) as SavedTurn;
const finalToolResult = finalTurn.events.flatMap(e => e.message?.content ?? [])
  .find(block => block.type === 'tool_result')?.content;
assert(finalToolResult);
const escape = (value: string): string => value.replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]!);
const number = (value: number): string => Math.round(value).toLocaleString('en-US');
const reduction = (before: number, after: number): string => `${(100 * (1 - after / before)).toFixed(1)}%`;
const firstFitted = summary.rows.find(row => row.abridged > 0);
const minutes = ((Date.parse(summary.finished) - Date.parse(summary.started)) / 60_000).toFixed(1);
const points = summary.rows.map((row, i) =>
  `${30 + i * 740 / Math.max(summary.rows.length - 1, 1)},${190 - row.stateTokens / 25_000 * 160}`).join(' ');
const bars = summary.rows.map(row =>
  `<div class="bar" title="Stage ${row.stage}: ${number(row.after)} / ${number(row.before)} characters"><span style="height:${100 * row.after / row.before}%"></span><small>${row.stage}</small></div>`).join('');
const rows = summary.rows.map(row => `<tr><td>${row.stage}</td><td>${number(row.before)}</td><td>${number(row.after)}</td><td>${reduction(row.before, row.after)}</td><td>${row.historyEntries}</td><td>${number(row.stateTokens)}</td><td>${row.abridged}</td><td>${row.artifactScore.toFixed(2)} ${row.artifactKept ? 'kept' : 'LOST'}</td><td>${row.rollbackScore.toFixed(2)} ${row.rollbackKept ? 'kept' : 'LOST'}</td></tr>`).join('');
const files = await readdir(directory);
const replays = files.includes('ablation-results.json')
  ? JSON.parse(await readFile(join(directory, 'ablation-results.json'), 'utf8')) as Replay[]
  : [];
const replayRows = replays.map(row => `<tr><td>${row.stage}</td><td>${escape(row.variant)}</td><td>${row.artifact.noul.toFixed(2)}</td><td>${row.rollback.noul.toFixed(2)}</td></tr>`).join('');
const baseline = files.includes('baseline-summary.json')
  ? JSON.parse(await readFile(join(directory, 'baseline-summary.json'), 'utf8')) as Summary
  : undefined;
const chunkReplays = files.includes('retention-comparison.json')
  ? JSON.parse(await readFile(join(directory, 'retention-comparison.json'), 'utf8')) as ChunkReplay[]
  : [];
const chunkRows = chunkReplays.map(row => `<tr><td>${row.stage}</td><td>${row.chunkLines}</td><td>${escape(row.wording)}</td><td>${row.artifactScore.toFixed(2)}</td><td>${row.rollbackScore.toFixed(2)}</td><td>${row.requests}</td><td>${number(row.inputTokens)}</td><td>${row.durationMs}</td></tr>`).join('');
const runNotes = files.includes('run-notes.txt') ? await readFile(join(directory, 'run-notes.txt'), 'utf8') : '';

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev · Long session evidence</title><style>
:root{color-scheme:light;--ink:#142b36;--muted:#526872;--green:#14694f;--line:#d4e1e3}
*{box-sizing:border-box}body{margin:0;background:#eef3f4;color:var(--ink);font:16px/1.6 system-ui,sans-serif}
main{max-width:1120px;margin:auto;padding:40px 30px 80px}header{padding:30px 0}h1{font-size:44px;line-height:1.15;letter-spacing:-1.5px;margin:16px 0}h2{font-size:24px;margin:0 0 15px}h3{font-size:18px}
p{max-width:850px}small,.muted{color:var(--muted)}.eyebrow{letter-spacing:2px;font-size:12px;text-transform:uppercase}.badge{display:inline-block;background:#d9f1e5;color:var(--green);font-weight:700;padding:5px 12px;border-radius:20px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.metric,section{background:white;border:1px solid var(--line);border-radius:12px;padding:25px}.metric strong{display:block;font-size:31px}.metric span{font-size:14px;color:var(--muted)}
section{margin-top:22px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f1f5f6;border:1px solid var(--line);padding:18px;border-radius:8px;font:13px/1.6 ui-monospace,monospace}
blockquote{border-left:4px solid var(--green);margin:16px 0;padding:1px 22px;background:#f3f9f6}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:right;padding:10px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted)}th:first-child,td:first-child{text-align:left}
.table{overflow-x:auto}.bars{height:180px;display:flex;gap:4px;margin:25px 0 45px;align-items:stretch}.bar{flex:1;background:#dfe9ec;position:relative;border-radius:2px}.bar span{position:absolute;background:var(--green);bottom:0;width:100%;border-radius:2px}.bar small{position:absolute;top:100%;font-size:10px;width:100%;text-align:center}
.failed{background:#ffe2de;color:#9c251c}
.legend{font-size:13px}.swatch{display:inline-block;width:12px;height:12px;background:var(--green);margin-right:6px}.swatch.original{background:#dfe9ec;margin-left:18px}
summary{cursor:pointer;font-weight:650;padding:12px 0}.note{border-left:4px solid #b27a20;padding-left:18px;color:#644b20}footer{margin-top:28px;font-size:12px;color:var(--muted)}
@media(max-width:720px){main{padding:24px 16px}.metrics{grid-template-columns:1fr 1fr}.cols{grid-template-columns:1fr}h1{font-size:34px}section{padding:18px}.bars{gap:2px}}
@media print{body{background:white}main{padding:0}section,.metric{break-inside:avoid}details{display:block}}
</style></head><body><main>
<header><div class="eyebrow">Jev pruner / live integration evidence</div><h1>${summary.passed ? `Earlier requirements survived<br>a ${summary.stages}-stage session.` : `The long session exposed<br>required output being dropped.`}</h1>
<p><span class="badge ${summary.passed ? '' : 'failed'}">${summary.passed ? 'Assertions passed' : 'Retention checks failed'}</span></p>
<p>One continuous Claude Code process executed a bootstrap command followed by ${summary.stages} noisy Bash commands. The production plugin used live Jev scoring throughout. ${summary.passed ? 'The final answer retained the target bundle, rollback reference, and deployment blocker.' : 'Earlier requirements reached Jev, but some required chunks scored below the 0.5 keep threshold. This run does not establish reliable retention.'}</p>
<p class="muted">${escape(summary.models.join(', '))} · ${minutes} minutes · ${summary.stages + 1} user turns · ${number(summary.messages)} transcript messages observed</p></header>
${runNotes ? `<section><h2>Run provenance</h2><pre>${escape(runNotes)}</pre></section>` : ''}
<div class="metrics">
<div class="metric"><strong>${reduction(summary.before, summary.after)}</strong><span>less output shown to Claude</span></div>
<div class="metric"><strong>${number(summary.before - summary.after)}</strong><span>output characters removed</span></div>
<div class="metric"><strong>${summary.rows.filter(row => row.artifactKept).length}/${summary.stages}</strong><span>target bundles retained</span></div>
<div class="metric"><strong>${number(Math.max(...summary.rows.map(row => row.stateTokens)))}</strong><span>peak fitted state tokens (estimate)</span></div>
</div>
${baseline ? `<section><h2>Before and after the retention fix</h2><p>The same scenario, fixtures, and acceptance checks were used for both sessions. The fix keeps 20-line chunks and the 0.5 threshold, strengthens the per-chunk question, and protects output whose complete text was absent from scoring state.</p><div class="table"><table><thead><tr><th>Measure</th><th>Original session</th><th>This session</th></tr></thead><tbody><tr><td>Target bundles retained</td><td>${baseline.rows.filter(row => row.artifactKept).length}/${baseline.stages}</td><td>${summary.rows.filter(row => row.artifactKept).length}/${summary.stages}</td></tr><tr><td>Rollback references retained</td><td>${baseline.rows.filter(row => row.rollbackKept).length}/${baseline.stages}</td><td>${summary.rows.filter(row => row.rollbackKept).length}/${summary.stages}</td></tr><tr><td>Failed assertions</td><td>${baseline.errors.length}</td><td>${summary.errors.length}</td></tr><tr><td>Output characters removed</td><td>${reduction(baseline.before, baseline.after)}</td><td>${reduction(summary.before, summary.after)}</td></tr></tbody></table></div><p class="muted">The larger reduction in the original session included unwanted losses. Claude responses differ between runs; this is an integration comparison, not a deterministic model evaluation.</p></section>` : ''}
${summary.errors.length ? `<section><h2>Observed failures</h2><p>${summary.rows.filter(row => !row.artifactKept).length} target bundles and ${summary.rows.filter(row => !row.rollbackKept).length} rollback references were removed from intermediate results. The final answer is checked separately. The captures do not prove that an answer-selection error was caused by trimming.</p><details><summary>Failed assertions</summary><pre>${escape(summary.errors.join('\n'))}</pre></details></section>` : ''}
<section><h2>The requirement, and the actual final answer</h2><div class="cols">
<div><h3>First user message</h3><pre>${escape(summary.firstHistory.find(h => h.role === 'user')?.text ?? '')}</pre><p class="muted">This requirement was present in the final Jev request's history. It was absent from the short “task” field after the first three stages.</p></div>
<div><h3>Claude’s final answer</h3><pre>${escape(summary.final)}</pre><p class="muted">Only supplied fixture commands were executed; no archive reads appeared in the captured tool calls.</p></div></div></section>
<section><h2>Trimming continued through the whole session</h2><p>${number(summary.before)} archived output characters became ${number(summary.after)} visible characters, including omission markers and preserved stderr. All archives contained 201 nonempty lines and the required values.</p>
<div class="legend"><span class="swatch"></span>Visible output<span class="swatch original"></span>Original output</div><div class="bars">${bars}</div>
<p class="muted">Each bar is one stage, normalized to that stage’s original output. Savings are measured in characters, not billable model tokens.</p></section>
<section><h2>History grew; scoring state stayed bounded</h2>
<p>Conversation text reached ${number(summary.rawHistoryTextChars)} characters. ${firstFitted ? `History abridgment began at stage ${firstFitted.stage}; the final request abridged ${summary.rows.at(-1)!.abridged} older entries.` : 'This run did not need history abridgment.'} Successful scoring states stayed within the configured 25,000-token estimate.</p>
<svg viewBox="0 0 800 220" role="img" aria-label="Estimated Jev state tokens by stage" style="width:100%">
<line x1="30" y1="30" x2="770" y2="30" stroke="#b27a20" stroke-dasharray="5 5"/><text x="30" y="20" fill="#795722" font-size="12">25,000 estimated-token limit</text>
<line x1="30" y1="190" x2="770" y2="190" stroke="#d4e1e3"/><polyline points="${points}" fill="none" stroke="#14694f" stroke-width="3"/>
<text x="30" y="212" fill="#526872" font-size="12">Stage 1</text><text x="700" y="212" fill="#526872" font-size="12">Stage ${summary.stages}</text></svg>
<p class="muted">${summary.requests} Jev requests; ${summary.recoveredRejections} rejected requests recovered through retry; ${summary.compactions} Claude auto-compaction events observed.</p>
<details><summary>Inspect early history from the final Jev request</summary><pre>${escape(JSON.stringify(summary.firstHistory, null, 2))}</pre></details>
<p>Tool-call history contains names, inputs, and status/length notes instead of result bodies. Assistant text that quotes a result remains conversation text; the test checks omission from tool metadata rather than claiming those quotations are removed.</p></section>
<section><h2>Inspect what Claude received</h2><p>The following is the exact final tool result from the CLI event stream.</p>
${summary.rows.some(row => row.stderrScored) ? `<p class="muted">In ${summary.rows.filter(row => row.stderrScored).length} stages, the fixture’s stderr text was included in the stdout sent to Jev and retained as the final chunk. These stages do not establish separate-stderr handling in the Claude host.</p>` : ''}
<details><summary>Final trimmed stdout and preserved stderr</summary><pre>${escape(finalToolResult)}</pre></details>
<details><summary>All ${summary.stages} stages and their measurements</summary><div class="table"><table><thead><tr><th>Stage</th><th>Original chars</th><th>Visible chars</th><th>Removed</th><th>History entries</th><th>Est. state tokens</th><th>Abridged entries</th><th>Target score</th><th>Rollback score</th></tr></thead><tbody>${rows}</tbody></table></div></details></section>
${replays.length ? `<section><h2>Controlled replays against live Jev</h2><p>Selected captured states were rescored unchanged, with the “do not repeat bundle names or rollback references” instruction removed, or with a standing-requirement clarification appended to scoring context. These trials preserve the per-chunk questions. They do not modify the production plugin or rerun Claude.</p><div class="table"><table><thead><tr><th>Stage</th><th>Variant</th><th>Target score</th><th>Rollback score</th></tr></thead><tbody>${replayRows}</tbody></table></div><p>Scores below 0.5 lose the required chunk. These context-only trials did not establish reliable retention.</p></section>` : ''}
${chunkReplays.length ? `<section><h2>Chunk size versus scoring wording</h2><p>Three captured failing states were replayed with the original question at 20, 5, and 1 line per chunk, and with the revised question at 20 lines. History and task text were held unchanged. Scores below 0.5 discard the required value. All question batches were sent concurrently.</p><div class="table"><table><thead><tr><th>Stage</th><th>Lines</th><th>Question</th><th>Target</th><th>Rollback</th><th>Requests</th><th>Input tokens</th><th>Elapsed ms</th></tr></thead><tbody>${chunkRows}</tbody></table></div><p class="muted">These isolated API replays bypass the production 200-chunk cap and history refitting to hold history fixed. Some finer-grained states exceed the production 25,000-token estimate; every request was batched below the 30,000-token estimate. Request counts and usage are measurements of these replays, not predictions for production. Latency is a single sample per case.</p></section>` : ''}
<section><h2>Reproduce and interpret</h2><pre>export TYPESAFE_API_KEY=...   # provide securely in your environment
npm run test:long-session
npm run report:long-session -- &lt;evidence-directory&gt;</pre>
<p>The harness uses the installed, authenticated Claude CLI, the production plugin, and a separate observer plugin that records Jev request bodies and responses. It never records HTTP headers. Prompts and command output are synthetic, with repetitive progress, selected bundle names, a rollback reference, and a simulated deployment error.</p>
<p class="note">This is a controlled long-session integration test, not a guarantee across all workloads. History is deliberately abridged under budget pressure. Jev scores remain probabilistic. Secret-like output forwarding remains unresolved.</p></section>
<footer>Claude session ${escape(summary.sessionId)}<br>Started ${escape(summary.started)} · Finished ${escape(summary.finished)}<br>Generated from captured request bodies, API responses, CLI events, and output archives.</footer>
</main></body></html>`;
await writeFile(join(directory, 'report.html'), html);
console.log(join(directory, 'report.html'));
