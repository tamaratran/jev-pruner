---
name: testing-jev-output
description: Run offline checks and verify live Jev Bash-output compaction in Claude Code without opening an interactive UI.
---

# Test Jev output compaction

## Setup and offline checks

Tested on macOS with Node 24.20.0 and Claude Code 2.1.274.
The package requires Node 18 or newer. From the repository root:

```sh
npm ci
npm test
npm run typecheck
npm run build
npm run validate:plugin
```

The repository currently has no standalone lint command or pre-commit configuration.
Plugin validation accepts the missing-author metadata warning.

## Live access

Use `TYPESAFE_API_KEY` for the Jev API and `ANTHROPIC_API_KEY` for Claude Code.
The existing personal TypeSafe testing secret grants access to `api.typesafe.ai`.
Obtain secrets through Devin's secret management tools; never write values to files.
`claude auth status` verifies the selected authentication source without revealing the key.

## Exercise the actual Bash hook

In a separate scratch directory, create a deterministic Node script that prints
about 12,000 characters of repetitive progress lines, a warning in the middle,
and a final summary. Keep output below Claude's own persistence threshold.
Use only synthetic, non-sensitive content.

Run Claude with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, `-p`,
`--plugin-dir <absolute-repo-path>`, `--model haiku`, `--effort low`,
`--setting-sources ''`, `--strict-mcp-config`, `--tools Bash`,
an `--allowedTools` rule restricted to that fixture's Node command,
`--max-budget-usd 1`, and `--output-format stream-json --verbose`.
Use `--debug-file` to retain hook diagnostics.
Ask Claude to execute the fixture once without piping, truncating, redirecting,
or reading other files, and report the summary and warning.

Inspect the stream's actual `tool_result`, not only Claude's final answer.
Verify the warning and summary remain, retained lines are verbatim and ordered,
and omitted spans have full-output markers.

The current plugin identity remains `fast-jev-output`; archives live under
`.claude/fast-jev-output/` in the session working directory. Compare the archive
against the original Bash stdout and check the directory's `*` gitignore rule.
Claude can strip the command's trailing newline before the hook receives stdout.

Debug logs show the hook loading, Jev HTTP status and duration, archive writes,
and the before/after character counts. Headless mode records toast calls in the
debug log but cannot demonstrate their visual presentation.

## Failure and cost checks

Run the same fixture with a deliberately invalid test key. Confirm the Jev 401
causes the entire original stdout to reach Claude and no archive is created.

Measure character reductions separately from estimated token reductions.
The repository estimator is not Claude's tokenizer. Record Jev's input/output
usage as overhead; do not claim net dollar savings from smaller stdout alone.
Audit development dependencies separately with `npm audit`; `npm audit --omit=dev`
checks the production dependency set.
