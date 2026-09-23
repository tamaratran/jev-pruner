import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { classifyInformation, isProtectedLine } from '../src/retention.js';
import { hash, type Candidate } from './prepare.mjs';
import type { Review } from './review.mjs';

export function vetoReason(text: string): string | null {
  if (text.split('\n').some(isProtectedLine)) return 'protected diagnostic or result';
  if (/\b\w*warnings?\b|\bdeprecated\b/i.test(text)) return 'warning or deprecation';
  if (/\b(?:error|fatal|panic|traceback|exception|failure|failed)\b/i.test(text) ||
      /^\s*File "[^"]+", line \d+/m.test(text)) return 'diagnostic or traceback';
  if (/\bexit(?:ed)?(?:\s+(?:code|status))?\s*[:=]?\s*-?\d+\b/i.test(text) ||
      /\bcommand (?:finished|completed)\b/i.test(text)) return 'final execution status';
  if (/^(?:diff --git |@@|\+\+\+ |--- )/m.test(text)) return 'source diff';
  if (classifyInformation(text) === 'reference' ||
      /^\s*(?:[+-]\s*)?(?:return|throw|raise|assert|if|else|elif|for|while|try|except)\b/m.test(text)) {
    return 'source or reference material';
  }
  if (/^\s*[a-zA-Z_][\w.-]*\s*=/m.test(text) ||
      /^\s*(?:\[[a-zA-Z_][\w.-]*\]|["']|[a-zA-Z_][\w.-]*:\s*$|[{}]\s*[,;]?$)/m.test(text)) {
    return 'configuration or structured reference';
  }
  if (/^\s*(?:#|\/\/|\/\*)/m.test(text)) return 'source comments';
  if (/^\s*\[{1,2}\s*-?\d+(?:\.|\s|,)/m.test(text)) return 'numeric output';
  if (/^\s*(?:platform |rootdir:|configfile:|plugins:)/m.test(text)) return 'test environment reference';
  return null;
}

export function audit(record: Candidate, review: Review) {
  if (review.candidateHash !== hash(JSON.stringify(record))) throw new Error('Stale review');
  const vetoes: { id: string; reason: string }[] = [];
  const drops = review.drops.filter(drop => {
    const chunk = record.state.chunks.find(chunk => chunk.id === drop.id);
    if (!chunk || !record.candidateDrops.includes(drop.id)) throw new Error('Invalid reviewed drop');
    const reason = vetoReason(chunk.text);
    if (reason) vetoes.push({ id: drop.id, reason });
    return !reason;
  });
  return { ...review, drops, policyAudit: {
    version: 'protected-evidence-v1', rawReviewHash: hash(JSON.stringify(review)), vetoes,
  } };
}

function main(): void {
  const { values } = parseArgs({ options: {
    candidates: { type: 'string' }, reviews: { type: 'string' }, out: { type: 'string' },
  } });
  if (!values.candidates || !values.reviews || !values.out) {
    throw new Error('Use --candidates candidates.jsonl --reviews raw-reviews.jsonl --out audited-reviews.jsonl');
  }
  const candidates: Candidate[] = readFileSync(values.candidates, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const reviews: Review[] = readFileSync(values.reviews, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const byId = new Map(reviews.map(review => [review.id, review]));
  if (byId.size !== reviews.length) throw new Error('Duplicate reviews');
  const audited = candidates.map(record => {
    const review = byId.get(record.id);
    if (!review) throw new Error(`Missing review for ${record.id}`);
    return audit(record, review);
  });
  writeFileSync(values.out, audited.map(record => JSON.stringify(record)).join('\n') + '\n', { flag: 'wx' });
  console.log(JSON.stringify({
    records: audited.length, drops: audited.reduce((n, record) => n + record.drops.length, 0),
    vetoes: audited.reduce((n, record) => n + record.policyAudit.vetoes.length, 0),
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
