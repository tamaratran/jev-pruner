# Eval suite

## Codex paired log-reading comparison

With Codex CLI 0.152.1 authenticated through ChatGPT, the installed Codex plugin
matching the current build, and `TYPESAFE_API_KEY` available:

```sh
npm run build
node evals/codex-cohort.mjs "$HOME/codex-cohort-new"
```

This freezes six pairs on the existing constructed build-log fixture, pins
GPT-5.5 with low reasoning and a 30,000-token tool-output budget, and alternates
native/pruned order. Both arms may recover missing information from an archive.
The harness audits recorded model-visible output, archive equality, retained
lines, and stderr; it grades facts separately from JSON formatting. It includes
both arms in the effectiveness cohort only if actual pruning occurred and both
arms passed the instrumentation audit. Incorrect answers and missing required
facts remain in that cohort. All trials, including exclusions, are preserved.

This is an exploratory log-reading comparison, not a coding benchmark.
GPT-5.5 uses the native shell transcript format; newer code-mode models require
separate validation of their outer output limits before using this protocol.
Caching is shared and uncontrolled. The saved API-equivalent model and Jev
estimates are reference-price calculations, not subscription charges or invoices.

## Pruning diagnostics and character chunking

Set `JEV_EVAL_DIAGNOSTICS=1` to capture a metadata-only decision for each Bash
result in the observer's UI logs. Set `JEV_EVAL_CHUNK_CHARS=4000` to opt into
character-target chunks; omit it to retain the production line-based default.
Both the smoke and Harbor adapter pass these through the inline plugin's
`pluginConfigs` entry. Full-run provenance records the options and refuses a
resume with different options.

The summarizer joins decisions to the final Claude transcript by tool-use ID.
It separates complete source size, hook stdout size, the host's native
model-visible text before pruning, and final model-visible text after pruning.
A positive `model_visible_char_delta_on_measured_calls` means the plugin made
those results *larger* than their native rendering, even if their archived source
was shortened. Missing before/after pairs remain unknown, never zero savings.
Counts use UTF-16 code units for consistency with the hook; they are not billed
token counts or a measurement of subsequent context replay.

`archive_accesses_observed` matches explicit archive paths in Read, Grep and Bash
arguments; it cannot see indirect filesystem reads. `repeated_bash_calls` counts
exact repeated command strings, not whether a repetition was caused by pruning.
The old `bash_observed_outputs_above_min_chars` field remains a historical
4,000-character statistic, not an activation metric for the 10,000-token gate.

For repeated comparisons, predeclare a complete paired manifest with an integer
`repetition` on each row and pass `--repetitions N` to `evals.full` (default 1).
Every task must have both arms in each repetition, with unique job names.
The coordinator can run separate repetitions concurrently but never overlaps
the two arms of the same task repetition. Aggregation preserves every pair.
Use a fresh evidence directory for each experiment. Pin task selection, repetitions,
arm order, options, model, versions and budgets before inference. Report all
planned rows and failures, success and total model-price estimates together,
with each repetition separate from historical trials. Subsets selected using
prior outputs are exploratory and do not estimate full-benchmark performance.

## Controlled repair and reference comparison

Build `evals/retention.Dockerfile` on the pinned Claude smoke image, then validate
the constructed pytest/TypeScript projects and their independent verifiers:

```sh
docker build -f evals/retention.Dockerfile -t jev-retention:2.1.274 .
python -m evals.retention_workloads "$HOME/retention-workload-validation-new"
```

Commit the candidate first. With the subscription mounts, Jev key and
`JEV_EVAL_DIAGNOSTICS=1` configured as below, run:

```sh
python -m evals.retention_cohort "$HOME/retention-disabled-new" \
  --cache-mode disabled --repetitions 2
```

This runs six task pairs (twelve trials) plus two startup checks, sequentially with
alternating arm order. The protocol and source hashes are written before
inference. Startup must authenticate, run the requested tool, produce a usable
result, and satisfy the requested cache mode. Disabled mode exports the documented
`DISABLE_PROMPT_CACHING=1` and requires nonempty usage with zero cache reads and
cache creation on every trial. Failed checks stop the run without retries.
Declare any separate `--cache-mode default` comparison before starting inference.
Startup calls warm both arms, but shared default caching remains uncontrolled;
do not pool prices across cache modes or claim equal cache states.

The two repair tasks execute actual tools over generated projects. Their initial
commands print the actual nonzero exit status and return normally so Claude gives
the hook a structured Bash record; throwing tool errors remain unchanged. The
reference task runs `pydoc pathlib`. These are controlled workloads, not a
Terminal-Bench or representative production sample.

Constructed workloads expose `Bash`, `Read`, `Grep`, and `Edit`; legacy fixture
mode exposes only `Bash`, `Read`, and `Grep`. The protocol records the same tool
list passed to Claude. Protected-file checks still reject edits outside the
permitted repair target.

`task_success`/`success` require an executable repair verifier and unchanged
protected input files, or a factual answer for the reference task. Report
`factual_pass`, `format_pass`, `strict_pass`, and `legacy_success` separately:
prose/fences and declared aliases can pass factual grading without passing the
bare-JSON format check. Missing facts, wrong values/types, duplicate keys and
conflicting JSON objects fail factual grading. Only instruction whitespace and
predeclared aliases are normalized.

Recovery observations include preceding explanations and the IDs of already
pruned results. They start as `unreviewed`: audit the required facts in the
visible result before classifying a read as missing information, verification,
prompt-induced, or unexplained. An archive access alone does not establish lost
information. Record cache validity, task failures, timeouts, visible characters,
repeated commands, model usage, and Jev request usage/latency together; the model
price estimate is not a Claude Max subscription charge.

## Retention activation preflight

Run the current preservation policy against six synthetic outputs above the
10,000-token gate using live Jev:

```sh
npx tsx evals/manual/retention.mts --run "$HOME/retention-preflight-new"
```

Requires `TYPESAFE_API_KEY` and a new absolute evidence directory whose parent
already exists. The runner records its fixed protocol before any request: three
repetitions of build, install, test, documentation, assembly, and source output
at 1,900- and 8,000-character budgets. The smaller budget approximates the space
remaining inside an observed Claude native preview after the archive footer;
the larger budget diagnoses the effect of the cap. These are direct function
tests, not changes to production settings or measurements of Claude usage.
Every result includes the decision, required-fact checks, exact output, Jev
responses, and latency. Reference cases must remain completely unchanged.
Inspect all declared cases, including cases that do not prune. A subsequent
Claude integration run still needs matching pruned transcript evidence before
an active-pruning comparison can be claimed.

Generate a fixture without making network requests:

```sh
npx tsx evals/manual/retention.mts --emit documentation
```

After native activation succeeds, run a small recovery-enabled comparison on
these fixtures:

```sh
JEV_EVAL_AUTH_MODE=subscription \
JEV_EVAL_CLAUDE_AUTH_DIR=/private/official-claude-config \
JEV_EVAL_DIAGNOSTICS=1 \
python3 -m evals.retention_cohort /new/cohort-evidence \
  --fixtures /completed/retention-preflight --repetitions 3 --cache-mode default
```

This uses the pinned local Docker smoke image, live Jev, and official Claude
subscription authentication. It predeclares six cases, three repetitions and
both arms (36 trials), alternating the first arm across cases/repetitions.
Recovery tools are allowed; subagents are unavailable. Each trial has 12 turns,
a five-minute timeout, a $1 CLI model-price budget and no retry. Grader answers
are not mounted in the container. Source hashes, prompts, fixture hashes, usage,
diagnostics, final answers, strict fact scores and every pending/finished row
are preserved. Instrumentation/authentication failures stop further launches.
This synthetic cohort uses neither Harbor nor Modal and cannot estimate
full-benchmark performance. Shared prompt caching limits cost attribution;
reported model-price estimates are not Claude Max charges.

## Historical plugin evals

The plugin and manual sweeps below predate the 10,000-token minimum. Their
recorded results are historical; cases at or below the current threshold pass
through without scoring. The Terminal-Bench harness is documented separately below.

Five cases run a noisy shell command and ask for a fact that is somewhere in its
output, so the score measures whether pruning loses information:

| Case | Output | The fact |
| --- | --- | --- |
| `needle-error` | 320 build lines, ~19k chars | the link failure and its undefined symbol |
| `needle-detail` | 300 inventory lines | a serial number on one line |
| `all-noise` | 300 latency lines | the two highest latencies |
| `summary-line` | 260 npm fetch lines + summary | packages added, install time |
| `structured-json` | a 120-service JSON document | one service's owner |

Each case also carries a `with-only` regex grader over the trace: `pruned`
asserts the pruning marker appears, and `not-pruned` (structured-json) asserts
it does not. These are indicators, not part of the score.

Run it:

```sh
claude plugin eval . --trust-plugin --allow-tools Bash Read Grep --runs 2
```

**Known limitation: the suite cannot exercise pruning.** An eval run disables
non-essential network traffic, so the hook's `$.http.fetch` to Jev is refused:

```
bash output trim skipped (fast-jev-output: $.http.fetch: refused: nonessential
network traffic is disabled for this session)
```

The hook itself does run — a probe that prefixes the tool result fires and sees
the full output — and the key does reach it, since `getApiKey` also reads
`EVAL_TYPESAFE_API_KEY` (an eval run gets a fresh HOME and a scrubbed
environment, so `TYPESAFE_API_KEY` and `pluginConfigs` do not):

```sh
EVAL_TYPESAFE_API_KEY="$TYPESAFE_API_KEY" claude plugin eval . --trust-plugin --allow-tools Bash Read Grep
```

But with the Jev call refused, the hook falls back to the original output, the
`pruned` indicators fail, and the scores only show that the plugin does no harm
when it cannot reach Jev. Use the manual eval below to exercise the real path.

## Manual eval

`evals/manual/run.mts` calls `trimOutput` directly against live Jev, so a sweep
costs cents and runs in seconds — the loop to use while tuning thresholds. Each
scenario carries the text an agent would need afterwards, and the run reports
whether it survived, how much went away, and how long a decision took.

```sh
TYPESAFE_API_KEY=... npm run eval:manual      # RUNS=3 by default
```

Twelve scenarios: eight that should trim (build error, pytest summary, npm
install, a serial number among 300 lines, two latency outliers, a stack trace,
grep hits, a Docker failure) and four that should pass through whole (a git log
where every line matters, a JSON document, binary data, short output).

Sweep on 2026-09-18, 3 runs per scenario, `jev-latest`:

| Measure | Result |
| --- | --- |
| Needles kept | 24/24 |
| Mean reduction | 83% (71–92%) on scenarios meant to trim |
| Wrongly trimmed | 0/12 pass-through runs |
| Mean latency | 240 ms |

Unlike the `claude plugin eval` cases above, this exercises the real pruning
path, because it does not go through the eval harness.

## Accuracy sweeps

Two more manual sweeps, same idea as above but wider:

```sh
TYPESAFE_API_KEY=... npm run eval:accuracy   # 12 output shapes x 3 needle positions
evals/manual/capture-real.sh /tmp/real       # capture real command output
REAL_DIR=/tmp/real TYPESAFE_API_KEY=... npm run eval:real
```

`accuracy.mts` is synthetic but varied: pytest failures, npm audit counts,
Docker build errors, Java stack traces, terraform replacements, CrashLoopBackOff
pods, git log, grep hits, `ps aux`, curl 500s, `du`, tar listings, and one case
where every line matters and nothing should go.

`real.mts` runs the same measure over output captured from real commands on the
machine, each with a specific needle: the failing pytest case, the test count,
a `TS2322` error among `--listFiles` noise, an express version in `npm ls`, a
commit subject in `git log --stat`, a `.d.ts` path in `find`, the largest
directory in `du`, `ls -laR`, a rate-limit header among 60 responses, and
`docker images`.

Results on 2026-09-18:

| Sweep | Retention | Mean reduction |
| --- | --- | --- |
| Standard (12 scenarios) | 8/8 | 83% |
| Accuracy (36 runs) | 36/36 | 87% |
| Real output (10 captures) | 10/10 | 54% |
| Needle matrix (sizes to 2.8 MB) | 9/9 | — |

Real output reduces less because three captures are correctly left whole:
pytest and vitest output below the threshold, and `docker images`, where Jev
wanted every line.

---

# Terminal-Bench paired pilot

Requires Linux, Docker, Python 3.12+, Claude access to `claude-sonnet-5`, and Jev API access.
Production source is uploaded unchanged. This adapter subclasses Harbor's
Claude Code agent; Harbor owns task installation, instructions, timeouts,
agent execution, transcripts, and verification.

```sh
python3 -m venv ~/harbor-venv
~/harbor-venv/bin/pip install harbor==0.22.0
export HARBOR_BIN="$HOME/harbor-venv/bin/harbor"
# Inject ANTHROPIC_API_KEY and TYPESAFE_API_KEY from your secret manager.
export EVIDENCE_DIR="$HOME/jev-eval-$(date +%s)"
# Run from a clean, committed checkout; do not reuse a previous output directory.
bash evals/pilot.sh
~/harbor-venv/bin/python evals/summarize.py "$EVIDENCE_DIR"
```

Before the pilot, verify Docker and run official oracles:

```sh
docker run --rm hello-world
"$HARBOR_BIN" run -d terminal-bench@2.0 -a oracle -i build-cython-ext -n 1 -r 0
"$HARBOR_BIN" run -d terminal-bench@2.0 -a oracle -i configure-git-webserver -n 1 -r 0
```

The fixed pilot is `build-cython-ext`, `chess-best-move`,
`configure-git-webserver` (the first three names in the official 2.0 sample).
It uses full dataset tasks from a pinned official registry revision, one
attempt per arm, no retries, fresh containers, default task resource/time
limits, Claude Code 2.1.274, high effort, 80 turns, and a $3 Claude budget per
trial. The budget may overshoot by a final API request and excludes Jev.
Ordering alternates between arms. Do not replace tasks after observing results.
The six runs are an integration pilot, not a full benchmark or significance test.
Full Terminal-Bench 2.0 has 89 tasks, hence 178 trials for a single paired run.

### Missing Debian mirror packages

An optional `JEV_EVAL_APT_CACHE_DIR` can supply archived `.deb` files when a
task image's live mirror no longer serves versions listed in its signed indexes.
Its `manifest.json` contains `distribution`, `codename`, and a `packages` array
of `filename`/`sha256` entries. Obtain checksums from APT's authenticated package
metadata and retrieve the exact package versions from an official archive.

The adapter verifies each local checksum, seeds only matching distributions, and
records the manifest in agent evidence. For matching images, it refreshes APT
indexes before staging the cache, then installs Harbor's required packages.
This ordering supports Docker images whose post-update hooks clear downloaded
archives. APT still selects and verifies packages; repository signatures and
package validation remain enabled. Record the cache manifest and setup change
in the evaluation protocol before resuming. Never repeat completed inference.

## Activation smoke

To evaluate another revision without changing the harness, set
`JEV_EVAL_PLUGIN_DIR` to an absolute, clean Git checkout of that revision.
The smoke and Harbor adapter load `.claude-plugin`, `hooks`, and `src` from
that checkout; the observer and orchestration remain in this repository.
The full runner hashes the selected production files, records both commits,
and rejects a resume with different production hashes. Keep both checkouts
unchanged while running.

Build a separate Docker image with Claude Code 2.1.274 installed from npm,
record its base digest, set `SMOKE_IMAGE` to that image, and run
`bash evals/smoke.sh` with a **new** `EVIDENCE_DIR`. Both arms execute the same
synthetic fixture. Assert control has no Jev requests or pruning markers;
plugin must show HTTP 200 captures, production trim logs, original archives,
and matching pruned tool results. A CLI exit code of zero alone proves nothing.
The smoke is not included in benchmark scores.
The smoke supports the same explicit API/subscription selection as the pilot.
In subscription mode it reuses the private read-only login mount, clears auth
overrides, forces Claude.ai, and runs the filtered auth preflight before inference.
Both arms require the pinned CLI and a successful measured result. The launcher
writes per-arm `summary.json` files and stops unless the treatment proves real
Jev responses and matching trimmed transcript results. Use committed sources and
a new absolute evidence directory outside the repo.

`JEV_EVAL_SMOKE_PROMPT` optionally selects a different synthetic activation
prompt for both arms. The launcher saves the exact prompt in `prompt.txt`.
Declare the fixture and required facts before running, keep the one-command
activation contract, and report the original smoke separately from alternatives.
For example, the live-retention fixture emitter can be invoked as
`node /plugin/node_modules/tsx/dist/cli.mjs /plugin/evals/manual/retention.mts --emit cache-build`
when the mounted checkout has its npm dependencies installed.

## Subscription authentication

`JEV_EVAL_AUTH_MODE=api` is the default and preserves the original API-key pilot.
For a separately authorized future run, `JEV_EVAL_AUTH_MODE=subscription` uses an
official Claude login directory mounted read-only outside the evidence tree.
It never extracts browser cookies or turns OAuth credentials into API keys.

Create a **dedicated** private directory outside the repo and evidence. With the
same pinned Claude image used for the smoke, the official browser login is:

```sh
export CLAUDE_AUTH_HOME="$HOME/.jev-claude-auth"
mkdir -p "$CLAUDE_AUTH_HOME"
chmod 700 "$CLAUDE_AUTH_HOME"
docker run --rm -it --network host --user "$(id -u):$(id -g)" \
  --env HOME=/claude-auth --env CLAUDE_CONFIG_DIR=/claude-auth/.claude \
  --mount "type=bind,src=$CLAUDE_AUTH_HOME,dst=/claude-auth" \
  "$SMOKE_IMAGE" claude auth login --claudeai
```

Follow the official browser flow and complete any account verification yourself.
If Claude displays a one-time code, paste it directly into the CLI prompt, never
into chat, a shell command, or a report. The CLI owns its local credential files.
This does not create a permanent Devin account secret.

Verify without inference using the same mount and environment, replacing the
last command with:

```sh
claude --setting-sources '' --settings '{"forceLoginMethod":"claudeai"}' auth status --json
```

Only when another evaluation is explicitly approved, configure the launcher:

```sh
export JEV_EVAL_AUTH_MODE=subscription
export JEV_EVAL_CLAUDE_AUTH_DIR="$CLAUDE_AUTH_HOME/.claude"
# Use a new EVIDENCE_DIR and keep TYPESAFE_API_KEY supplied as before.
# bash evals/smoke.sh starts the paired activation smoke.
# bash evals/pilot.sh starts inference; authentication alone does not authorize it.
```

The subscription pilot stops after any failed command, incomplete/invalid trial,
or Claude error, including authentication, model-access, and rate-limit errors.
It does not retry, switch models, or fall back to API billing. A completed verifier
reward of zero remains a valid result and does not stop the pilot.

Each disposable container copies only the CLI's `.credentials.json` and
`.claude.json` from the read-only mount into a new private Claude config directory
under `/opt/jev-eval/auth`. Neither file enters Harbor's log directory. Projects
and native transcripts are linked to the current trial's fresh evidence directory.
Skills, plugins, memories, and old transcripts from the login directory are not
copied. CLI token refresh writes stay in the disposable container and are discarded
on teardown; reauthenticate the source directory if its login stops working.
Do not archive the login directory or export credential-bearing container images.

The adapter removes API keys, auth tokens, alternate-provider routing, custom
headers, and OAuth-token overrides both from its environment mapping and at the
container shell boundary. It ignores user/project settings, rejects custom Harbor
settings in subscription mode, and forces `claudeai` login. A filtered
`claude auth status --json` preflight runs during setup and immediately before the
agent starts. Any missing login, API auth, or alternate provider stops execution.
Only the auth method/provider, login boolean, and recognized plan name are recorded.
This checks local authentication selection, **not** model availability, remaining
plan allowance, or a server-validated inference request.

Claude normally prefers an approved `ANTHROPIC_API_KEY` over subscription OAuth.
The official `claude setup-token` / `CLAUDE_CODE_OAUTH_TOKEN` alternative is useful
for CI, but this adapter's subscription mode intentionally uses the mounted browser
login and clears token overrides so it cannot silently select a different account.

Subscription use draws from the plan's limits (and any enabled extra-usage policy).
CLI dollar totals and `--max-budget-usd` are model-price accounting, not a verified
subscription invoice or an account spending cap. Keep token counts, durations, and
the reported dollar estimate separately; never relabel the original API pilot as
subscription usage. Jev remains a separate service with its own key and costs.

Official references:
- [Authentication and precedence](https://code.claude.com/docs/en/authentication)
- [Container authentication](https://code.claude.com/docs/en/devcontainer)
- [CLI login, status, and setup-token](https://code.claude.com/docs/en/cli-reference)
- [Headless mode](https://code.claude.com/docs/en/headless)
- [Subscription SDK/CLI usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

Harbor sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, which prevents
function-hook HTTP requests. The adapter removes this variable in both arms;
even the string `"0"` blocked requests with the pinned CLI. Telemetry, error
reporting, and auto-update are individually disabled instead. The bundled
`plugin-authoring` plugin is disabled explicitly. Both arms load only the
pass-through observer; treatment additionally loads `fast-jev-output`.
No user/project settings or MCP configuration is loaded.

## Evidence

### Offline Modal budget audit

Before spending credits, prepare a plan from a clean task checkout at the
registry's exact commit:

```sh
python -m evals.modal_budget /absolute/evidence/modal-plan.json \
  --registry /absolute/evidence/registry.json \
  --benchmark-source /absolute/terminal-bench-2 \
  --exclusions /absolute/evidence/exclusions.json \
  --budget-usd 30
```

Download the registry from the immutable `REGISTRY` URL in `evals/full.py`.
The exclusions file is a JSON object mapping task names to review reasons
(`{}` only after scope review finds no exclusions). Both arms remain in the
planning manifest, with missing rewards rather than fabricated zero scores.
This command never starts compute, inference or image builds. Its output is an
audit document, not an input to `evals.full`.

The estimate uses **Sandbox** CPU/memory prices, task timeouts, a 600-second setup
allowance (Harbor's default is 360), 300 seconds for transfers/teardown, and a 25%
reserve. The build allowance is priced at task resources. Builder resources,
memory bursts, image tags, remote teardown and workspace billing must still be
validated; this is not an enforceable account cap. Report Modal, Jev and Claude
accounting separately. Coordinate any other run using the same subscription
before starting live validation.

### Full comparison

`python -m evals.full EVIDENCE --benchmark-source PINNED_TASK_CHECKOUT` executes
a predeclared `EVIDENCE/manifest.json` with 178 rows across all 89 tasks. Each row
contains `task`, `arm`, a unique `job_name`, and a `resource_blocked` boolean from
the resource audit. Keep blocked tasks in the manifest. Alternate arm ordering
by task before starting, and store the complete protocol/provenance with it.
Use the same subscription environment described above and a committed checkout.
The optional `--harbor` argument selects the pinned virtual environment's CLI.

For a separately authorized recovery cohort, create a fresh evidence directory
and declare both arms of each selected task before inference. Pass `--task-count N`
to require exactly `2*N` trials with unique job names and complete pairs; the
default still requires all 89 tasks. Record the selection rule and original
evidence hashes in the new protocol. Preserve previous attempts and report
recovery results separately rather than silently replacing them.

For Modal sandboxes, install `modal==1.5.1 dockerfile-parse==2.0.1` in the Harbor
virtual environment and authenticate with `modal token new`. Pass
`--environment modal` to the full runner. Task CPU and memory declarations remain
unchanged; audit the selected Modal workspace's capacity before clearing local
`resource_blocked` flags in a new manifest. Modal compute is billed separately.
The runner pins Modal's image builder to `2025.06` for this process, preserving
upstream image working directories and avoiding legacy Python injection.

Remote subscription setup uploads only `.credentials.json` and optional
`.claude.json` through Harbor's sandbox file-transfer interface into a private
directory outside logs. It does not create a Modal Secret, Volume, or credential
image. The private runtime copy and source staging files disappear on sandbox
teardown. Docker keeps its read-only bind mount. Modal's agent logs are downloaded
at trial boundaries, so account-error inspection may occur after a trial ends.

The launcher defaults to one active trial. Set `--concurrency 4` to run up to four
independent task sandboxes at once. Both arms of a task retain their manifest order
and never overlap. Each Harbor subprocess still uses one trial and zero retries;
the pilot's model, version, and limits stay fixed. Subscription rate limits and
Modal capacity constrain useful concurrency. It refuses reused run directories
by default and checks source hashes before
each trial. Results checkpoint after every trial, preserving missing rewards and
unstarted tasks. Subscription/account/model errors and instrumentation/Jev failures
pause new launches and create `blocker.json`; other already-running trials finish
and checkpoint before the launcher exits. Ordinary task failures remain
in the results. A paused run must be inspected before any separate continuation.
For a live coordinator handoff on Linux, suspend the old coordinator without
signaling its Harbor process groups. Construct an `evals.process.AdoptedProcess`
for each live child using its PID, the old coordinator PID, and its checkpointed
command; then call `run(..., resume=True, concurrency=32, inflight={job_name:
process, ...})`. The process wrapper verifies the parent, process group, and
command, and tracks process start time to avoid following a reused PID. Keep the
old coordinator stopped until it is terminated; only the replacement may write
checkpoints. It counts adopted jobs toward the concurrency limit and retains
their launch commit and concurrency, recording the handoff separately. Exit codes
of adopted children remain unavailable; Harbor result files determine outcomes.
After inspecting and resolving a pause, stop the previous launcher and pass
`--resume` with the same evidence directory. Completed trials are retained, never
retried; only pending manifest rows execute. A checkpoint interrupted after Harbor
finished can be reconstructed from its saved result. An unfinished Harbor trial
blocks resumption. Flags, manifest order, and production source hashes must match.
Instrumentation fixes are permitted and recorded in `execution-segments.json`;
each trial records its execution commit and concurrency. The initial provenance is
preserved. Changing concurrency on resume is permitted; record the protocol
amendment and account for overlapping workloads when interpreting runtime.
The launcher stops before another trial when less than 20 GiB disk is free.
CLI-native request retries, if any, are not additional Harbor trial attempts.

`execution-provenance.json` pins the actual execution commit and flags. The
separate preflight provenance can refer to the preceding adapter commit when
only orchestration was added after the smoke; production and observer hashes must
match across preflight and execution. Never edit sources while a run is active.

The observer adapts `tests/fixtures/long-session-observer`. It never modifies
requests/results and never captures HTTP headers. It captures activation,
started/completed Jev requests with response usage/latency, production log
messages, Bash results, and copies of archives written by the production plugin.
Claude's native originals are already downloaded under `sessions/projects`; the
summarizer validates their presence there without reading sandbox footer paths.
Native Claude transcripts remain authoritative for
what the model saw. Plugin presence is checked in Claude's init event.
Missing final events and CLI errors are failures, not successful agent runs.

`summarize.py` preserves missing values, failures, cache creation/read tokens,
CLI-reported Claude cost, Jev usage, timing, and actual pruning counts. Jev
pricing is unknown unless independently supplied; it is never counted as free.
Claude's total includes auxiliary models when present; per-model and aggregate
tokens are retained. A `costBasis: list` value is a CLI list-price calculation,
not an independently verified billing statement.
Cache sharing at the provider is possible across fresh containers; compare
uncached, cache-write and cache-read tokens separately and disclose run order.
Oracle failure is a task-validity caveat, not automatically an agent failure.

Review and sanitize all evidence before sharing: although headers are omitted,
task output or debug logs could contain credentials. Never commit transcripts,
settings caches, or bulky reports. Keep the dependency lock, task locks/image
digests, exact commands, and separate infra errors with the delivered artifacts.

## Checks

```sh
npm test
npm run typecheck
npm run build
npx tsc -p evals/tsconfig.json
ruff check evals
ruff format --check evals
mypy --follow-imports=silent --disable-error-code=import-untyped evals
python -m unittest discover -s evals -p 'test_*.py'
bash -n evals/pilot.sh evals/smoke.sh
```

Harbor 0.22.0 does not ship `py.typed`; only that third-party import diagnostic
is disabled for mypy.
