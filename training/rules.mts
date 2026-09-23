import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { basename } from 'node:path';
import { classifyInformation, isProtectedLine } from '../src/retention.js';

interface Record {
  state: { chunks: { id: string; text: string }[] };
  questions: { [id: string]: { type: 'noul'; label: boolean; src: string } };
  _meta: { id: string; group_id: string; source: string; variant: string };
}

const { values } = parseArgs({ options: {
  input: { type: 'string' }, out: { type: 'string' }, 'allow-test': { type: 'boolean' },
} });
if (!values.input || !values.out) throw new Error('Use --input partition.jsonl --out rows.json');
if (basename(values.input) === 'test.jsonl' && !values['allow-test']) {
  throw new Error('Locked test requires --allow-test after development selection');
}
const records: Record[] = readFileSync(values.input, 'utf8').trim().split('\n').map(line => JSON.parse(line));
const rows = records.flatMap(record => Object.entries(record.questions).map(([id, question]) => {
  const chunk = record.state.chunks.find(chunk => chunk.id === id);
  if (!chunk || question.type !== 'noul') throw new Error('Expected chunk retention question');
  const keep = classifyInformation(chunk.text) !== 'progress' || chunk.text.split('\n').some(isProtectedLine);
  return {
    id: record._meta.id, group: record._meta.group_id, question: id,
    source: record._meta.source, task: question.src, variant: record._meta.variant,
    type: question.type, keys: ['false', 'true'], label: Number(question.label),
    p: keep ? [0, 1] : [1, 0],
  };
}));
writeFileSync(values.out, JSON.stringify(rows), { flag: 'wx' });
console.log(JSON.stringify({ questions: rows.length, rule: 'keep unless all lines are unprotected progress' }));
