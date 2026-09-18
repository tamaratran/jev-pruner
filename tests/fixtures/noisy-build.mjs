const stage = Number(process.argv[2]);
if (!Number.isInteger(stage) || stage < 0) throw new Error('Expected a nonnegative stage');

if (stage === 0) {
  console.log('OLDER_BASH_RESULT_ONLY_79a61e: disposable bootstrap diagnostic');
} else {
  const lines = Array.from({ length: 200 }, (_, i) =>
    `progress: stage ${stage} cache entry ${i} already current; no changes needed`);
  lines[65] = `bundle Q7 = release-Q7-stage${stage}-6d81.tar.gz`;
  lines[105] = `bundle P9 = release-P9-stage${stage}-72bc.tar.gz`;
  lines[125] = 'ERROR: deployment blocked because the release directory is not writable.';
  lines[145] = `rollback stable-snapshot = snapshot-stage${stage}-a312`;
  lines[199] = `Stage ${stage} finished; deployment remains blocked.`;
  console.log(lines.join('\n'));
  console.error(`stderr: stage ${stage} diagnostic channel preserved`);
}
