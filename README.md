# jev-pruner

A Claude Code plugin that uses TypeSafe's Jev to trim noisy Bash output **after
the command runs, but before its result is sent back to the main LLM**. This
reduces the output carried into later turns without generating a summary.

Using Codex? See [Codex installation and usage](#codex).

```text
Claude requests a Bash command → Command runs → Jev prunes stdout → Claude receives the result
```

1. A `tool.call` hook wraps the Bash tool's `next()` result.
2. Stdout of **10,000 estimated tokens or fewer** passes through untouched,
   without reading history, writing an archive, or calling Jev. The gate uses
   `estimateTokens` on raw stdout, not a character count or an exact model tokenizer.
   `minTokens` can raise this threshold but cannot lower it. If Claude already saved
   the output to a file, the hook reads and counts that full output instead of its
   short preview. Errors, JSON/XML/YAML/diff/binary output,
   whole-document commands (`cat`, `jq`, `git diff`, `git show`, `base64`, and
   `openssl`) are left untouched. Recognized documentation, source code, and
   disassembly are also preserved, regardless of which command printed them.
3. Output is split into chunks of `chunkLines` lines, capped at 200 chunks;
   lines longer than 2,000 characters are split first.
   The opt-in `chunkChars` setting groups these lines toward a character target
   instead. Adjacent groups merge as needed to retain the 200-chunk cap, so the
   target is not a hard maximum. Neither mode bypasses the token floor or
   document/error protections.
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
   each history segment. Scoring requests run in parallel within the request
   allowance. A chunk is fully scored only after evaluation against every
   history segment. A `max_tokens_exceeded` response
   retries twice with a halved state budget and repartitions the original history.
6. A chunk stays when **any query** gives it a noul of at least `keepThreshold`
   or above `0.1`, it is first or last, it contains a recognized diagnostic or
   result (including warnings, test totals, and artifact paths), or its complete text was not
   scored against every history segment (for example, a single chunk that cannot
   fit beside a segment). No partially shown chunk can be discarded.
7. Each dropped run becomes `[N lines omitted]`.
   Adjacent omissions across chunk boundaries share one marker. The Claude hook
   labels retained lines as verbatim and puts the archive path in a single footer;
   all metadata counts toward the native preview budget. Library callers can
   enable this rendering with `compactMarkers: true`.
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

Explicit Bash commands containing a successfully pruned archive's path bypass
further pruning in the same hook instance. Read and Grep are already unaffected.
Recovery remains available; the plugin does not prevent the agent from checking
an archive. Indirect reads through aliases or variables are not recognized.

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
| Whole document | JSON objects/arrays, XML root tags or declarations, YAML headers, diffs; recognized Markdown, API help, source definitions, disassembly; `cat`, `bat`, `jq`, `yq`, `git diff`, `git show`, `diff`, `base64`, `openssl` | Preserve the output verbatim without scoring. Content detection takes precedence over a build or search command. |
| Unknown | Custom scripts, unrecognized subcommands, wrappers, pipelines, compound commands | Use the existing general scoring guidance. Existing whole-document safeguards still take precedence. |

Command recognition is deliberately limited to simple invocations. Executable
paths and leading environment assignments are recognized; shell operators,
substitutions, and wrappers fall back to general guidance unless a whole-document
safeguard applies. This is a heuristic, not a shell parser. All categories keep
the strict **over 10,000 estimated tokens** gate. Category guidance counts toward
the state budget in every history segment and output batch.

### Information retention rules

Each scoring question labels its content as reference, diagnostic, result,
progress, or unknown. Content classification is independent of command
classification: a Python command can print documentation, and a build command
can print source code.

| Information | Retention rule |
| --- | --- |
| Recognized documentation, source code, or assembly | Preserve the entire output without calling Jev, including mixed output with an initial log banner. |
| Diagnostics and results | Keep matching lines and adjacent context even if Jev considers them disposable. Includes warnings, failures, test totals, exit status, and explicit artifact/report paths. |
| Task-dependent facts | Ask Jev against every history segment. A keep vote from any segment protects the content. Refinement uses the same rule for smaller groups. |
| Uncertain meaning | Preserve: removal requires a keep probability at most `0.1` and below `keepThreshold` in every history segment. |
| Progress and boilerplate | Eligible for removal only after that confidence check; a progress label alone never authorizes removal. |
| Missing scoring coverage or failed refinement | Preserve the unscored content or original chunk. |

The content recognizer is a conservative heuristic, not a parser for every
language or document format. Unrecognized content still goes to Jev with the
instruction to retain information whose meaning or relevance is uncertain.
The probability cutoff is a retention policy, not a measured error guarantee.
All rules apply above the existing token floor; none lowers that floor.

Refinement scores individual lines when a retained chunk exceeds its share of
the character budget; otherwise it scores five-line groups. Each line still
requires complete history coverage and the same confidence check before
removal. Diagnostics, results, and their adjacent context remain protected.
Scoring includes detected diagnostic and result lines from the complete output,
so a progress-only fragment can be evaluated alongside the final outcome.
Only the complete output's boundaries and context beside protected facts are
mandatory; internal chunk edges can be removed after complete line scoring.

Retention takes precedence over the output-size budget. If safe refinement
cannot fit, the hook returns the original host result, including its native
preview and full-output reference. It does not force a smaller replacement by
dropping content classified as needed. Diagnostics include `informationCategory`
without logging the output text.

## Codex

Codex CLI 0.152.1 does not support replacing native shell output from
`PostToolUse`. The Codex integration is an **opt-in command wrapper and skill**,
not automatic interception. Its `PreToolUse` hook only records a transcript
pointer; it never rewrites commands or returns an approval decision.

### 1. Install Codex and sign in

These terminal commands use Bash or Zsh on macOS/Linux. Install
[Git](https://git-scm.com/downloads) and [Node.js 18+](https://nodejs.org/en/download)
(which includes npm), then install the Codex CLI version used in our validation:

```sh
npm install -g @openai/codex@0.152.1
codex --version
codex login
codex login status
```

Complete the browser sign-in with your ChatGPT account. If you already have
Codex 0.152.1 installed and authenticated, skip the install and login commands.

### 2. Configure Jev access

Create a [TypeSafe API key](https://console.typesafe.ai/settings/keys) and ensure
your account has [API credits](https://console.typesafe.ai/settings/billing).
**Your Codex subscription runs Codex; Jev scoring uses the separate TypeSafe API
and incurs TypeSafe usage.**

Make `TYPESAFE_API_KEY` available in the terminal where you will launch Codex.
You can use your existing secret manager or enter it without echoing the key
or putting it in shell history:

```sh
printf 'TypeSafe API key: '
read -r -s TYPESAFE_API_KEY
printf '\n'
export TYPESAFE_API_KEY
```

Paste the key at the prompt and press Enter. This export lasts for the current
terminal session; repeat it in a new terminal or use your existing environment
configuration. Do not put the key in a Codex prompt or commit it to the repository.

### 3. Build and install the plugin

Run these commands in your terminal:

```sh
git clone https://github.com/tamaratran/jev-pruner.git
cd jev-pruner
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-pruner@jev-pruner-codex
codex plugin list --json
```

The list should show `jev-pruner@jev-pruner-codex` with `installed: true` and
`enabled: true`. Keep the checkout: the registered local marketplace points to it.
**Build before installing.** Installing directly from the Git URL does not
compile TypeScript or supply the required `dist/codex/run.js`.

### 4. Start Codex and trust the hook

From the project you want to work on, in the terminal containing your API key:

```sh
cd /path/to/your/project
codex --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -c tool_output_token_limit=30000
```

This starts a new session with workspace-write sandboxing and network access so
the wrapper can reach `https://api.typesafe.ai/v1/systemone`. Command approvals
still apply. The 30,000-token setting raises Codex's separate host output limit;
otherwise Codex can truncate a result even after the wrapper has pruned it.

Inside Codex, open `/hooks`, review the `jev-pruner` `PreToolUse` hook, and trust
it. That hook records the current transcript location so Jev can score against
the conversation. An untrusted hook leaves the wrapper without the history it
needs, so output passes through unchanged.

The API key must also reach Codex's shell commands. The wrapper does not change
Codex's environment filtering, network policy, or approval settings. If your
configuration blocks the key or endpoint, use your approved environment/network
configuration; pruning fails open while access is unavailable.

### 5. Use the skill

In the Codex prompt, explicitly invoke the installed skill:

```text
$jev-pruner Run npm test through the pruner and report the test results.
```

Replace `npm test` with your non-interactive build, test, install, or search
command. The skill resolves its installed location and calls the wrapper for
you. Commands that Codex runs outside the wrapper are not intercepted.

For a known noisy example, start Codex in the `jev-pruner` checkout and send:

```text
$jev-pruner Run node tests/fixtures/codex-noisy-build.mjs 1 once through the wrapper.
This is a synthetic fixture; do not fix its simulated deployment error.
Report the bundle Q7 and rollback stable-snapshot values.
```

That fixture produces output above the 10,000-estimated-token gate. When Jev
removes output, the tool result contains `[fast-jev-output trimmed ...]` markers
and ends with:

```text
[fast-jev-output full output: <archive-path> (Read or grep it if needed)]
```

The complete original stdout is in `.jev-pruner/` under the command's working
directory. To read more detail later, ask Codex:

```text
Read the full-output archive referenced in the last result and show the exact
line containing "cache entry 20 ". Do not rerun the command.
```

Short output, failed commands, protected formats, and output Jev considers
necessary may remain unchanged. Only an omission marker confirms pruning;
the absence of an error does not.

### Updating or removing the Codex plugin

From your original `jev-pruner` checkout:

```sh
git pull --ff-only
npm ci
npm run build
codex plugin remove jev-pruner@jev-pruner-codex
codex plugin add jev-pruner@jev-pruner-codex
```

Start a new Codex session and review any changed hook through `/hooks`.
Rebuilding the checkout alone does not refresh the installed plugin's cached files.
To uninstall without reinstalling, run only
`codex plugin remove jev-pruner@jev-pruner-codex`. Existing output archives remain
in the projects where the commands ran.

### Troubleshooting

| Symptom | Check |
| --- | --- |
| `codex: command not found`, or no `plugin` subcommand | Check that npm's global executables are on `PATH` and `codex --version` reports the tested CLI version above. |
| The skill is unavailable | Check `codex plugin list --json`, then start a new session after installation. |
| `dist/codex/run.js` cannot be found | Run `npm ci` and `npm run build` in the checkout, then remove and reinstall the cached plugin as above. |
| Large output is unchanged | Confirm Codex used the wrapper, the hook is trusted, the command succeeded, and the output is eligible. Check API-key availability, Jev network access, and TypeSafe credits; missing access or scoring failures preserve stdout. |
| Jev returns HTTP 402 | Add TypeSafe API credits. Your Codex subscription does not fund Jev requests. |
| Codex reports output truncation | Use the larger `tool_output_token_limit` shown above and read the original archive when available. This limit is separate from the pruning threshold. |

To check key availability without revealing it, ask Codex to run:

```sh
node -e 'console.log(process.env.TYPESAFE_API_KEY ? "TYPESAFE_API_KEY is set" : "TYPESAFE_API_KEY is missing")'
```

### How the Codex wrapper works

The skill runs non-interactive commands through the native Codex shell using
the installed plugin root, not necessarily the source checkout:

```sh
node "<installed-plugin-root>/dist/codex/run.js" -- npm test
```

The executable and arguments after `--` are passed directly, preserving cwd,
environment, stdin, stderr, and exit status. Explicitly select a shell for a
shell program (`-- bash -c 'command1 && command2'`). Interactive commands, live
progress streams, servers, and machine-readable nested tool calls should use
the ordinary shell. Stdout is buffered until command completion; above 8 MiB,
the wrapper switches to unchanged streaming to bound memory use. Nonzero exits,
invalid UTF-8, and credential-like commands/output pass through without scoring.

The strict over-10,000-token gate, categories, complete-history partitioning,
verbatim retention, and incomplete-scoring safeguards reuse the same pruning
engine as Claude. The host transcript pointer is stored under
`~/.cache/jev-pruner/codex/<session-id>.json`. `CODEX_THREAD_ID` selects the
current session; the rollout's session ID must match. The adapter reads recorded
user/assistant messages and full tool inputs/results, including custom tools.
It does not load reasoning items or system/developer prompts. Earlier originals
that Codex already truncated or compacted are not reconstructed.
Unavailable, malformed, or mismatched history disables pruning.

Before scoring, original stdout is archived in the command workdir's
`.jev-pruner/` directory with private file permissions and a local `.gitignore`.
Stderr remains unchanged on its original stream. Successful pruning ends with
the archive recovery footer. Archives and transcript pointers persist until
manually removed. API requests time out after 30 seconds and failures preserve
stdout. Jev receives the recorded conversation and tool results; secret detection
is a heuristic for the current command/output, not transcript redaction.

### Sustained Codex validation

After building and installing the local plugin, authenticate Codex and supply
`TYPESAFE_API_KEY` to run the billable CLI integration test:

```sh
JEV_CODEX_STAGES=2 npm run test:codex-session   # short harness check
npm run test:codex-session                    # 40 stages, handoff, then archive recovery
```

Set `JEV_CODEX_PLUGIN_ROOT` if the installed plugin is outside the default
`~/.codex/plugins/cache/jev-pruner-codex/jev-pruner/0.1.0` directory.
Set `JEV_CODEX_MODEL` to select an available Codex model instead of its default.
Reinstall the plugin after rebuilding changed source so the test exercises that revision.
The harness runs this reviewed local plugin with Codex's per-invocation hook-trust
bypass. It retains the `workspace-write` sandbox and enables network access for
Jev; it does not disable command approvals or change persistent Codex settings.
It sets `tool_output_token_limit=30000` for each invocation: a larger shell-call
`max_output_tokens` alone does not override the host's default 10,000-token limit.

Each stage checks required values from an early user requirement and an earlier
tool result, exact retained lines, stderr, pruning markers, archive bytes, and
complete Jev responses. Later stages must exercise parallel history partitions.
The final handoff cannot read archives. A separate turn then requires Codex to
use the archive footer to recover an omitted line with one read-only command;
the full line is withheld from that request. Missing commands, host truncation,
rate limits, timeouts, retention failures, and incomplete runs fail the test.
Private evidence under `~/jev-codex-session-*` includes per-turn CLI events,
header-free Jev requests/responses, per-stage metrics, and the final verdict.
Generate a self-contained HTML report with
`node tests/codex-session-report.mjs <evidence-directory> [...]`.
The report shows the last stage's complete original and model-visible outputs,
the lines retained verbatim, and the archive-recovery command and result.
The synthetic fixture tests sustained history growth; it is not a benchmark of
typical coding sessions.

### Paired Codex source investigations

With the same installed plugin, Codex login, and TypeSafe key, run
`npm run test:codex-real` to compare native and pruned output on three source
investigations. The test clones the current committed checkout into a private
workspace, runs real repository searches above the token threshold, and checks
each answer against facts withheld from the prompt. It requires actual pruning,
unchanged retained lines, complete native output, and byte-exact archives.

Private evidence is saved under `~/jev-codex-real-tasks-*`. Generate a side-by-side
HTML report with `node tests/codex-real-tasks-report.mjs <evidence-directory>`.
These are code-analysis checks with one run per condition, not implementation
benchmarks or proof of general accuracy or total-cost savings.

## Claude Code install

The project is named **jev-pruner**, but its current Claude Code plugin and
marketplace identifiers are still `fast-jev-output`. Use those identifiers in
the commands and settings below.

### 1. Enable function hooks and configure your API key

You need Claude Code with early-access function-hook support and a TypeSafe API
key. In your personal Claude Code settings, merge in:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1",
    "TYPESAFE_API_KEY": "<your key>"
  }
}
```

Replace `<your key>` with your TypeSafe API key. Keep it out of version control.
You can also supply `TYPESAFE_API_KEY` through your shell environment or set the
plugin's `apiKey` option. Restart Claude Code after changing the environment
settings.

Function hooks are early access and may change between Claude Code releases.
The checked-in declarations were generated by Claude Code 2.1.274.

### 2. Install the plugin

Run in your terminal:

```sh
claude plugin marketplace add tamaratran/jev-pruner
claude plugin install fast-jev-output@fast-jev-output
```

Start a new Claude Code session after installation.

### 3. Use Claude Code normally

No special prompt is required. When an eligible Bash result is pruned, a toast
reports the reduction and the result includes markers where output was removed.
When saved, those markers point to the full output under
`.claude/fast-jev-output/`, which Claude can read if needed.

Not every long result will be trimmed: important output may be kept in full.

### Local checkout alternative

Instead of the marketplace install, run this from the repository root with your
TypeSafe API key configured as above:

```sh
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```

## Output the engine saved

When Bash output is too large to show inline, Claude Code saves the whole thing
and hands the model a head-of-file preview — usually the least interesting part.
The plugin prunes that saved file instead, caps the result at
`persistedMaxChars` so it fits inline, and cites the engine's own saved copy in
the markers, so nothing becomes unrecoverable. Set `persistedOutputs` to false
to leave those results alone.

When the host supplies its model-visible preview, that preview's character count
also caps the replacement, including omission markers and the archive footer.
Compressing a large archive must not expand an already-short native preview.
If protected content cannot fit, the original result passes through.

The budget includes omission markers and the archive footer. Reference material,
diagnostics, results, uncertain or task-required content, and output that could
not be fully scored take precedence over this budget. If safe refinement cannot
fit, the original result passes through; failed refinement never falls back to
keeping only error-shaped lines.
Before scoring, a lower bound counts protected diagnostics/results, their adjacent
context, boundary lines, and fixed compact metadata. If these cannot fit, no Jev
request is made. Refinement also stops once lines already retained make a fit
impossible.

The Claude hook allows at most 12 total Jev requests by default, further limited
to `ceil(visibleChars / 192)` (minimum one). `visibleChars` is the smaller of the
native preview size and the configured output cap; without a native preview it
uses the source size capped by the configured output budget. For a 2,146-character
preview this allows twelve requests. This is an effort heuristic, not a pricing or
savings guarantee.

`maxScoringRequests` limits additional calls beyond the first, shared by initial
scoring, retries, and refinement; zero permits one call. The hook default is 11.
Direct library callers retain the default of 40 additional requests and can
override it explicitly. Incomplete scoring always preserves the unscored content.
Requests take one output batch from every history segment before moving to the
next batch, so a limited allowance can still finish scoring some chunks.

A 76,379-char log went from a 2,227-char preview that did not contain the error
line to 4,013 chars of pruned output that did.

## Configuration

Use `/plugin configure fast-jev-output` inside Claude Code, or merge a
`pluginConfigs` entry into your Claude Code settings:

```json
{
  "pluginConfigs": {
    "fast-jev-output@fast-jev-output": {
      "options": { "minTokens": 10000, "chunkLines": 20, "keepThreshold": 0.5 }
    }
  }
}
```

| Option | Default | Description |
| --- | ---: | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key |
| `minTokens` | `10000` | Estimated stdout token threshold; minimum 10,000; equality skips pruning |
| `persistedOutputs` | `true` | Prune eligible output saved by Claude |
| `persistedMaxChars` | `8000` | Rendered budget for saved output, including markers and the footer; 0 disables this configured cap. The native preview size, when available, remains an upper bound |
| `maxScoringRequests` | `11` | Additional Jev calls beyond the first; shared across scoring, retries and refinement. Also bounded by visible preview size. 0 permits one call |
| `chunkLines` | `20` | Lines grouped into each Jev decision chunk |
| `chunkChars` | `0` | Optional character target instead of line grouping; 0 uses `chunkLines` |
| `diagnostics` | `false` | Log decision reasons, source/hook sizes, native model-visible size before pruning when available, request count and elapsed time; no commands or output text |
| `keepThreshold` | `0.5` | Minimum Jev probability for a chunk to remain; the uncertainty safeguard also retains scores above `0.1` |
| `maxStateTokens` | `25000` | Estimated token budget for the Jev state |
| `model` | `jev-latest` | TypeSafe Jev model name |

The old `minChars` option is no longer used; replace it with `minTokens`.

Diagnostics distinguish the complete source from the host's preview and the
native text the model would have seen. The post-pruning model-visible size must
be read from the final transcript: the host may persist the returned text again.
Character counts are UTF-16 code units, not billed tokens. Library callers may
use `onDecision(reason)` in `trimOutput` options for the terminal decision.

## Data and privacy

Jev receives command output and partitioned conversation context through the TypeSafe
API to decide what to keep. The main LLM receives the pruned result when trimming
succeeds. Jev requests incur API usage.

Full output is saved locally before the first scoring request. The archive directory
is self-gitignored. Credential-like commands or output detected by the plugin
are not archived; their markers say to re-run the command instead. **This check
only prevents local archiving—it does not redact secrets or prevent content
from being sent to Jev.**

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
