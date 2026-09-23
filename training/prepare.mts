import { createHash } from 'node:crypto';
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { splitHistory } from '../src/history.js';
import { type NoulQuestion } from '../src/jev.js';
import { chunkOutput, classifyOutput, exceedsOutputThreshold, questionFor, scoringRequests, type stateFor } from '../src/output.js';
import { isProtectedLine } from '../src/retention.js';

export const SOURCE = 'ayanami-kitasan/swe-pruner-pro-training-corpus';
export const REVISION = '6bd52ba1d430eebcd6262a4147c7243cb2e8dd1b';
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

export function repositoryFor(issue: string): string {
  const match = /^mswe_[^_]+_([^_]+)__(.+)-\d+$/.exec(issue) ?? /^([^_]+)_(.+)_pr\d+$/.exec(issue);
  if (!match) throw new Error('Unknown source issue format');
  return `${match[1]}/${match[2]}`.toLowerCase();
}

export interface Candidate {
  id: string;
  issue: string;
  repository: string;
  state: ReturnType<typeof stateFor>;
  questions: Record<string, NoulQuestion>;
  candidateDrops: string[];
  provenance: {
    source: string;
    revision: string;
    sourceRow: number;
    rowSha256: string;
    confidence: string;
    runtimeEligible: boolean;
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}

export function keptLines(value: unknown, total: number): Set<number> {
  if (!Array.isArray(value)) throw new Error('Missing retained-line annotation');
  const result = new Set<number>();
  for (const item of value as unknown[]) {
    const range = typeof item === 'string' ? /^(\d+)-(\d+)$/.exec(item) : null;
    const start = range ? Number(range[1]) : item;
    const end = range ? Number(range[2]) : item;
    if (typeof start !== 'number' || typeof end !== 'number' ||
        !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) {
      throw new Error('Invalid retained-line annotation');
    }
    for (let line = start; line <= end; line++) result.add(line);
  }
  return result;
}

export function selectedOutputLines(output: string, annotation: unknown): Set<number> {
  const sourceLines = output.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
  if (sourceLines.at(-1) === '') sourceLines.pop();
  const selected = keptLines(annotation, sourceLines.length);
  const result = new Set<number>();
  let sourceLine = 1;
  let outputLine = 1;
  for (let index = 0; index < output.length; index++) {
    if (selected.has(sourceLine)) result.add(outputLine);
    const char = output[index]!;
    if (char === '\r' && output[index + 1] === '\n') {
      sourceLine++; outputLine++; index++;
    } else if (char === '\n') {
      sourceLine++; outputLine++;
    } else if (/[\r\v\f\x1c-\x1e\x85\u2028\u2029]/.test(char)) {
      sourceLine++;
    }
  }
  return result;
}

export function convert(raw: string, sourceRow: number): Candidate | null {
  const row = object(JSON.parse(raw) as unknown);
  const issue = text(row.instance_id);
  const repository = repositoryFor(issue);
  const output = text(row.tool_response);
  const lines = output.split('\n');
  if (lines.some(line => line.length > 2_000)) return null;
  const kept = selectedOutputLines(output, row.kept_frags);
  const call = object(row.tool_call);
  const args = object(typeof call.arguments === 'string' ? JSON.parse(call.arguments) as unknown : call.arguments);
  const command = typeof args.command === 'string' ? args.command :
    typeof args.cmd === 'string' ? args.cmd :
    typeof args.keystrokes === 'string' ? args.keystrokes : `${text(call.name)} ${JSON.stringify(args)}`;
  if (!Array.isArray(row.history)) throw new Error('Missing history');
  const messages = (row.history as unknown[]).map(value => {
    const entry = object(value);
    const role = text(entry.role);
    const extra = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'role' && key !== 'content'));
    const content = entry.content == null && Object.keys(extra).length ? '' :
      typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content);
    if (content === undefined) throw new Error('Missing history content');
    return {
      role: role === 'assistant' ? 'assistant' as const : 'user' as const,
      text: `${role === 'assistant' || role === 'user' ? '' : `[Source role: ${role}]\n`}${content}` +
        (Object.keys(extra).length ? `\n${JSON.stringify(extra)}` : ''),
      toolUses: [],
      originalRole: role,
    };
  });
  const goal = messages.find(message => message.originalRole === 'user')?.text;
  if (!goal) return null;
  const chunks = chunkOutput(output, 20, 0);
  if (!chunks.length) return null;
  const input = { goal, command, output };
  const category = classifyOutput(command, output);
  const pastHash = hash(JSON.stringify({ issue, input, messages }));
  const histories = splitHistory(messages, 1_024);
  const historyIndex = Number.parseInt(pastHash.slice(0, 8), 16) % histories.length;
  const requests = scoringRequests(input, chunks, [histories[historyIndex]!], 4_096);
  if (!requests.length) return null;
  const requestIndex = Number.parseInt(pastHash.slice(8, 16), 16) % requests.length;
  const { state, batch } = requests[requestIndex]!;
  const requested = new Set(batch.map(chunk => chunk.id));
  const questions: Candidate['questions'] = {};
  const candidateDrops: string[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    if (!requested.has(chunk.id)) { offset += chunk.lines; continue; }
    const question = questionFor(chunk)[chunk.id]!;
    if (question.type !== 'noul') throw new Error('Retention question must be noul');
    questions[chunk.id] = question;
    const sourceKeeps = Array.from({ length: chunk.lines }, (_, index) => offset + index + 1)
      .some(line => kept.has(line));
    if (!sourceKeeps && !chunk.text.split('\n').some(isProtectedLine) && row._confidence === 'confident') {
      candidateDrops.push(chunk.id);
    }
    offset += chunk.lines;
  }
  return {
    id: hash(`${issue}\n${JSON.stringify(state)}`),
    issue,
    repository,
    state,
    questions,
    candidateDrops,
    provenance: {
      source: SOURCE, revision: REVISION, sourceRow, rowSha256: hash(raw),
      confidence: typeof row._confidence === 'string' ? row._confidence : 'missing',
      runtimeEligible: exceedsOutputThreshold(output) && category !== 'document',
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    input: { type: 'string' }, out: { type: 'string' },
    limit: { type: 'string', default: '5000' },
  } });
  if (!values.input || !values.out) throw new Error('Usage: prepare.mts --input corpus.jsonl --out candidates.jsonl');
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid limit');
  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  const counts = { scanned: 0, excluded: 0, invalid: 0, duplicate: 0 };
  const invalidReasons: Record<string, number> = {};
  for await (const raw of createInterface({ input: createReadStream(values.input), crlfDelay: Infinity })) {
    counts.scanned++;
    if (counts.scanned % 1000 === 0) console.log(JSON.stringify({ ...counts, eligible: candidates.length }));
    try {
      const record = convert(raw, counts.scanned);
      if (!record) { counts.excluded++; continue; }
      const stateHash = hash(JSON.stringify(record.state));
      if (seen.has(stateHash)) { counts.duplicate++; continue; }
      seen.add(stateHash);
      candidates.push(record);
    } catch (error) {
      counts.invalid++;
      const reason = error instanceof Error ? error.message.slice(0, 80) : 'Unknown error';
      invalidReasons[reason] = (invalidReasons[reason] ?? 0) + 1;
    }
  }
  candidates.sort((a, b) => hash(`sample-v1:${a.id}`).localeCompare(hash(`sample-v1:${b.id}`)));
  const selected = candidates.slice(0, limit);
  writeFileSync(values.out, selected.map(record => JSON.stringify(record) + '\n').join(''), { flag: 'wx' });
  const report = { ...counts, invalidReasons, eligible: candidates.length, selected: selected.length,
    issues: new Set(selected.map(record => record.issue)).size,
    repositories: new Set(selected.map(record => record.repository)).size,
    questions: selected.reduce((sum, record) => sum + Object.keys(record.questions).length, 0),
    proposedDrops: selected.reduce((sum, record) => sum + record.candidateDrops.length, 0),
    runtimeEligible: selected.filter(record => record.provenance.runtimeEligible).length,
    source: SOURCE, revision: REVISION, status: 'unreviewed; not training labels' };
  writeFileSync(`${values.out}.report.json`, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
