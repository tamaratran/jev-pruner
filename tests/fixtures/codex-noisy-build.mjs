const stage = Number(process.argv[2]);
if (stage === 0) {
  console.log('Deployment plan: target Q7; rollback track stable-snapshot.');
  console.log('CODEX_PRIOR_RESULT_ONLY_719: retain the matching bundle and rollback from later builds.');
} else {
  await import('./noisy-build.mjs');
}
