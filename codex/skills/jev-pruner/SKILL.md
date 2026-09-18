---
name: jev-pruner
description: Use Jev to prune lengthy output from non-interactive build, test, install, and search commands in Codex.
---

Resolve the plugin root as three directories above this skill's directory.
The installed plugin must already have `dist/codex/run.js` built.

For non-interactive commands that may produce lengthy output, use the native
Codex shell tool to execute:

```sh
node "<plugin-root>/dist/codex/run.js" -- npm test
```

Arguments after `--` are passed directly to the executable, without evaluation
by a second shell. Preserve their quoting. For a compound shell program, pass
the intended shell explicitly, for example `-- bash -c 'command1 && command2'`.
Keep the original workdir, sandbox settings, and approval requirements.
Do not request broader permissions solely to make pruning work.

Use the ordinary shell directly for interactive/TTY commands, servers, commands
whose live progress is required, whole-file reads, diffs, structured data, and
commands involving secrets. Do not wrap nested calls that require machine-readable
output. This wrapper buffers stdout until completion (up to 8 MiB), forwards stderr
unchanged, and preserves the exit code. It does not intercept other shell calls.

Only stdout over 10,000 estimated tokens is eligible. The trusted `PreToolUse`
hook records the current transcript path; the wrapper uses `CODEX_THREAD_ID` to
load that session's user/assistant messages and complete recorded tool results.
Missing history, missing `TYPESAFE_API_KEY`, blocked Jev network access, failed
commands, archive failures, and scoring failures return the original stdout.
Never claim pruning occurred without seeing an omission marker.

Read or search the archive path in the final footer whenever omitted output is
needed. Retained text is verbatim; Jev does not generate a summary.
