# fast-jev-output

Trims long Bash output with TypeSafe's Jev *before* it is recorded as the tool
result, so the noise never enters the model's context. Every later turn
re-sends the whole transcript, so a single 100k-character dump is otherwise
paid for on every request; trimming it once at the source saves input tokens
on every turn and keeps the prompt-cache prefix stable. Kept lines are
verbatim — nothing is rewritten or summarized.

## How it works

1. A `tool.call` hook wraps the Bash tool's `next()` result.
2. Stdout of **10,000 estimated tokens or fewer** passes through untouched,
   without reading history, writing an archive, or calling Jev. The gate uses
   `estimateTokens` on raw stdout, not a character count or an exact model tokenizer.
   `minTokens` can raise this threshold but cannot lower it. If Claude already saved
   the output to a file, the hook reads and counts that full output instead of its
   short preview. Errors, JSON/XML/YAML/diff/binary output,
   whole-document commands (`cat`, `jq`, `git diff`, `git show`, `base64`, and
   `openssl`) are left untouched.
3. Output is split into chunks of `chunkLines` lines, capped at 200 chunks;
   lines longer than 2,000 characters are split first.
4. Jev receives `{ context, task, history, command, chunks }`, plus `category` and
   `categoryGuidance` for recognized build/test/install or search/excerpt commands,
   and one noul question
   per chunk: “does any line in this chunk need to remain available?”. A single
   needed line protects the chunk, including values required by earlier
   instructions even when the next reply must not repeat them. `history` includes
   user/assistant text, complete tool inputs, and tool-result text and structured
   data from the current session. Identical results attached to both a tool call
   and a result message are sent once, linked by their tool-use ID.
   Questions are batched so each request stays under 30,000 estimated tokens.
5. History and output share `maxStateTokens`, using a digit-aware estimate.
   History gets at least half the budget, with more available when the current
   output is small. Oversized history is partitioned in order across requests,
   without truncating or omitting message text, tool arguments, or results.
   Individual oversized fields become continuations labeled with their field
   name and character offset. Complete output chunks are grouped to fit alongside
   each history segment. All scoring requests run in parallel; each scored chunk
   is evaluated against every history segment. A `max_tokens_exceeded` response
   retries twice with a halved state budget and repartitions the original history.
6. A chunk stays when **any query** gives it a noul of at least `keepThreshold`, it is first or
   last, it matches an error or warning pattern, or its complete text was not
   scored against every history segment (for example, a single chunk that cannot
   fit beside a segment). No partially shown chunk can be discarded.
7. Each dropped run becomes a marker such as:
   `[fast-jev-output trimmed N lines (M chars); full output: .claude/fast-jev-output/bash-<id>.txt (Read or grep it if needed)]`
8. Before the first scoring request, the complete stdout and stderr are saved
   under the project's `.claude/fast-jev-output/` directory (self-gitignored).
   When Claude already persisted the complete output, that file is reused as the
   archive. Successful pruning replaces Claude's file-preview metadata with the
   retained text and archive footer. Read or scoring failures preserve the original
   result and its file reference. Claude may persist the pruned result again if it
   still exceeds its display limit; the archive footer then lives inside that file.
   A final `[fast-jev-output full output: <path> (Read or grep it if needed)]`
   footer follows the trimmed stdout. Archives persist for later recovery,
   including when scoring ultimately keeps everything or fails.
   Credential-like commands or output are not archived by the plugin; their omission
   markers instruct the agent to re-run the command instead.
9. Any archive write failure, Jev failure, or state that cannot fit leaves the original output untouched.
   Separate inline stderr is left unchanged. Host-persisted output is scored as
   the combined stream supplied by Claude.

The hook reads the current transcript for each command; it does not maintain a
separate history store. Claude Code's `session.messages()` returns the main
conversation's user/assistant messages (up to the newest 4,096), not the system
prompt or a subagent's own transcript. `task` is still a short extract of the
last three user prompts; `history` supplies the earlier instructions and
assistant decisions and tool results as returned by the host, including any
pruning already applied to earlier results. Archived originals are not reloaded.
Partitioning preserves coverage, but a query sees only its own history segment;
facts that require combining distant segments are not guaranteed to be recognized.
More segments and output groups mean more Jev requests.
Library callers can pass the same transcript shape through
`trimOutput({ command, goal, output, messages }, asker)`.

### Command categories

Categories add guidance to the same relevance question; they never mark an entire
command's output as disposable or change the keep threshold.

| Category | Examples | Behavior |
| --- | --- | --- |
| Build, install, test | `npm run build`, `pnpm test`, `npm ci`, `make`, `pytest`, `cargo test` | Ask Jev to retain diagnostics, failing tests, result counts, final status, artifact paths, and task-required values; repeated progress may be dropped. |
| Search or file excerpt | `rg`, `grep`, `git grep`, `find`, `head`, `tail`, `sed` | Treat paths, line numbers, matches, and surrounding source as evidence. Repeated matches can still matter, particularly when the task requires complete results or counts. |
| Whole document | JSON objects/arrays, recognized XML/YAML headers, diffs; `cat`, `bat`, `jq`, `yq`, `git diff`, `git show`, `diff`, `base64`, `openssl` | Preserve the output verbatim without scoring. Format detection takes precedence over a build or search command. |
| Unknown | Custom scripts, unrecognized subcommands, wrappers, pipelines, compound commands | Use the existing general scoring guidance. Existing whole-document safeguards still take precedence. |

Command recognition is deliberately limited to simple invocations. Executable
paths and leading environment assignments are recognized; shell operators,
substitutions, and wrappers fall back to general guidance unless a whole-document
safeguard applies. This is a heuristic, not a shell parser. All categories keep
the strict **over 10,000 estimated tokens** gate. Category guidance counts toward
the state budget in every history segment and output batch.

## Install

Enable early-access function hooks in Claude Code settings:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "TYPESAFE_API_KEY": "<your key>"
  }
}
```

Install from the marketplace:

```sh
claude plugin marketplace add tamaratran/jev-pruner
claude plugin install fast-jev-output@fast-jev-output
```

For local development:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

Configure values with `/plugin configure fast-jev-output`, or use a
`pluginConfigs` entry in Claude Code settings:

```json
{
  "pluginConfigs": {
    "fast-jev-output@fast-jev-output": {
      "options": { "minTokens": 10000, "chunkLines": 20, "keepThreshold": 0.5 }
    }
  }
}
```

## Options

| Option | Default | Description |
| --- | ---: | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `minTokens` | `10000` | Estimated stdout token threshold; minimum 10,000; equality skips pruning |
| `chunkLines` | `20` | Lines grouped into each Jev decision chunk |
| `keepThreshold` | `0.5` | Minimum Jev probability for a chunk to remain |
| `maxStateTokens` | `25000` | Estimated token budget for the Jev state |
| `model` | `jev-latest` | TypeSafe Jev model name |

Function hooks are early access and may change between Claude Code releases.
The checked-in declarations were generated by Claude Code 2.1.274.
The old `minChars` option is no longer used; replace it with `minTokens`.

## Tests

Run the offline checks with `npm test`, `npm run typecheck`, and `npm run build`.
`npm run validate:plugin` checks the plugin with the installed Claude Code CLI.

For live Jev checks, provide `TYPESAFE_API_KEY` in the environment and run
`npm run test:live`. This makes billable requests using synthetic conversation
and output fixtures. It checks task-dependent retention, tool-result inclusion,
parallel history/output batching, digit-heavy state budgets, paired comparisons
of general versus category guidance on build and search fixtures, and the hook's behavior when Jev
rejects authentication. It runs separately from `npm test` and does not exercise
the Claude Code host itself.

### Long Claude Code session

With an authenticated Claude CLI and `TYPESAFE_API_KEY` in the environment, run
`npm run test:long-session`. This starts one continuous Claude process, loads the
production plugin plus a test-only observer, and runs a bootstrap followed by
40 noisy Bash commands against synthetic fixtures. Both Claude and Jev incur
API usage; the Claude process has a $10 budget. Each prompt explicitly confirms
the finite benchmark because Claude may otherwise decline the repeated
simulated failures. If a stage contains no tool call, the runner sends one
direct confirmation in the same session; a second refusal stops the run.
Confirmations are saved in the evidence and counted as additional user turns.
The one-command-per-stage and retention assertions still apply.
Set `JEV_LONG_SESSION_BUDGET_USD` to override the Claude cap for longer runs,
for example `JEV_LONG_SESSION_TURNS=100 JEV_LONG_SESSION_BUDGET_USD=25 npm run test:long-session`.
The selected cap and stage count are saved with the evidence; the cap excludes Jev charges.

`npm run test:archive-recovery` runs a separate two-turn Claude session. It checks
that an unpredictable cache hash is absent from the compacted output, then asks
Claude to recover it using `Read` and the archive footer. Each CLI invocation
has a $2 Claude cap; this billable test requires the same authentication as the
long-session test.

The test checks early requirements, tool-result inclusion,
target bundle and rollback retention, archives, stderr, history partitioning, and
the final answer. Conversation text that quotes tool output is preserved.
Raw events and header-free Jev request/response captures are saved under
`~/jev-long-sessions/`. The path is printed when the run starts.

Run `npm run report:long-session -- <evidence-directory>` to generate a
self-contained HTML evidence report. For a quick harness smoke check,
set `JEV_LONG_SESSION_TURNS=2`; runs of at least 40 stages require history-partitioning coverage.
Use `JEV_LONG_SESSION_DIR` to choose a different persistent output directory.
The long test is separate from the offline suite and `test:live`.
Retention failures produce a failing exit status and a summary containing all
misses. To reanalyze saved evidence without making API calls, run
`npm run test:long-session -- --analyze <evidence-directory>`.

Related: [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)
(same author) applies Jev to session compaction; the two are independent and
can be installed together.

## Animated demo (macOS)

`demo/JevPrunerDemo` matches the dark terminal, scanning beam and collapsing
output of the fast-jev-compaction demo. An `npm install` is followed by a scan,
pruning, and a pause on the retained summary. The terminal's top bar
shows estimated output tokens. There are no surrounding captions or sidebar.
Retained text stays verbatim and a saved-log card shows where the original
output can be read.

`npm-install.json` records each output line's arrival time and the process
duration from an actual install of a small React project with
`npm_config_loglevel=verbose`; the displayed command remains `npm install`.
Machine-specific CLI, log-file and working-directory metadata were removed.
The original install takes **4.648 seconds**. Playback shortens gaps between
visible output arrivals to at most **0.35 seconds**, so the preview does not
appear stalled while unshown lines arrive. Shorter intervals retain their
recorded timing. The same time mapping drives the token count and completion.
The install now plays in approximately **1.85 seconds**; the complete animation
is approximately **5.6 seconds**, including scanning, a smooth shared collapse
and a 1.25-second final hold.

Representative rows append and stay in place, instead of cycling a scrolling
viewport or switching to a different layout at completion. The status labels
the shortened pauses. Export plays once; Space manually replays the native app.

This is recorded playback, not a live install or benchmark; it makes no API
requests. The pruning animation and keep/drop decisions are illustrative at
line granularity, rather than the default 20-line chunks.
Token estimates use one token per four characters of the capture and the
illustrated compact text, including its archive marker; they are not measured
model usage. Omission markers are shortened for readability.
The full-output path uses the plugin's existing `fast-jev-output` directory.

Requires macOS 14+ and the Xcode command-line tools. No extra packages are needed.

```sh
demo/JevPrunerDemo/build.sh             # build and open; Space replays
demo/JevPrunerDemo/build.sh --no-launch # build without opening a window
demo/JevPrunerDemo/build.sh --export "$PWD/demo/JevPrunerDemo/build/jev-pruner.mp4"
demo/JevPrunerDemo/build.sh --frame 5 "$PWD/demo/JevPrunerDemo/build/poster.png"
```

Export renders the same timeline directly to a 1100×720 H.264 MP4 at 30 fps.
Use a new output filename for each movie export; existing movies are not
overwritten. Build products and exports under the demo's `build/` are ignored.
