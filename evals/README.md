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

## Activation smoke

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

For non-mounted Harbor environments (including Modal), the adapter uploads only
those two login files through `environment.upload_file()` into a fresh mode-700
staging directory, secures the files with mode 600, then performs the same private
runtime preparation before Claude installation. It does not put Claude credentials
in image layers, evidence, or named Modal Secrets. Docker keeps its read-only bind
mount path. Set `EVIDENCE_DIR` even when invoking Harbor directly so the source
directory can be checked against the evidence path.

This credential transport alone does not make `evals.full` a Modal launcher:
that scheduler still defaults to Docker and inspects local Docker image digests.
A Modal run also needs explicit environment selection, guaranteed task resources,
bounded sandbox lifetime, remote image provenance, verified evidence downloads,
and a creation-retry policy; Harbor 0.22.0 retries sandbox creation internally
despite `--max-retries 0`. Do not use the Docker launcher unchanged for Modal.

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

### Full serial comparison

`python -m evals.full EVIDENCE --benchmark-source PINNED_TASK_CHECKOUT` executes
a predeclared `EVIDENCE/manifest.json` with 178 rows across all 89 tasks. Each row
contains `task`, `arm`, a unique `job_name`, and a `resource_blocked` boolean from
the resource audit. Keep blocked tasks in the manifest. Alternate arm ordering
by task before starting, and store the complete protocol/provenance with it.
Use the same subscription environment described above and a committed checkout.
The optional `--harbor` argument selects the pinned virtual environment's CLI.

The launcher runs serially with the pilot's model, version, limits, and zero
Harbor retries. It refuses reused run directories and checks source hashes before
each trial. Results checkpoint after every trial, preserving missing rewards and
unstarted tasks. Subscription/account/model errors and instrumentation/Jev failures
pause further execution and create `blocker.json`; ordinary task failures remain
in the results. Any environment or agent setup failure also pauses the run before
the next trial; setup failures are classified using Harbor's recorded execution
phase. A paused run must be inspected before any separate continuation.
The launcher stops before another trial when less than 20 GiB disk is free.
CLI-native request retries, if any, are not additional Harbor trial attempts.

`execution-provenance.json` pins the actual execution commit and flags. The
separate preflight provenance can refer to the preceding adapter commit when
only orchestration was added after the smoke; production and observer hashes must
match across preflight and execution. Never edit sources while a run is active.

### Modal: pinned preflight and matched execution

Use `evals.modal_runner` to select the bounded Modal provider. It uses Harbor's
`Trial.create` and `install_only` APIs, not the Docker subprocess launcher.
Requires Python 3.12, Harbor 0.22.0, Modal 1.5.1, dockerfile-parse 2.0.1 and
official Modal profile authentication. Keep the feature checkout committed:
production files must match `907353b80f159bd3d693d6fbb310b1f6bf10c2d3`.
The dataset must be a clean checkout of
`69671fbaac6d67a7ef0dfec016cc38a64ef7a77c`.

Offline planning constructs all 89 provider configurations without SDK calls:

```sh
export PYTHONPATH=/home/ubuntu/repos/jev-pruner
export BENCHMARK=/home/ubuntu/jev-eval/benchmark-source
export PLAN=/home/ubuntu/jev-modal-execution-plan-v4
/home/ubuntu/harbor-venv/bin/python -m evals.modal_runner plan \
  --benchmark-source "$BENCHMARK" --plan "$PLAN"
```

Only after explicit compute approval, the following runs serial image/resource/
auth preflights. It installs Claude Code, uploads allowlisted subscription
files privately, checks `claude auth status`, large-file read/write, loopback TCP
and tool availability, then downloads and hashes evidence before termination.
It does not run Claude inference, Jev requests, or task verifiers.

```sh
export MODAL_PROFILE=jev-terminal-bench
export JEV_EVAL_AUTH_MODE=subscription
export JEV_EVAL_CLAUDE_AUTH_DIR=/home/ubuntu/.jev-claude-auth/.claude
export MODAL_BUDGET_USD=28.26
export MODAL_BILLING_START=2026-09-18
/home/ubuntu/harbor-venv/bin/python -m evals.modal_runner preflight \
  --benchmark-source "$BENCHMARK" --plan "$PLAN" \
  --evidence /home/ubuntu/jev-modal-preflight-v4 \
  --budget-usd "$MODAL_BUDGET_USD" --build-reserve-usd 0.25 \
  --billing-start-date "$MODAL_BILLING_START" --approve-modal-compute
```

These example values preserve $1.74 for this session's earlier setup attempts
within the single $30 authorization. For a new experiment, use its authorized
remaining budget, billing start date and fresh evidence/plan directories.

The first task requests 1 physical core and 2 GiB. At the quoted Sandbox rates,
60–300 seconds costs approximately $0.0032–$0.0158, excluding image import/build
costs. Its 810-second sandbox deadline reserves about $0.0427; the launcher also
reserves the task's build allowance plus $0.25 for unmetered image import work.
The build reserve is an explicit planning margin, **not a known price or cap**.

With `--billing-start-date`, the runner reads `Workspace.billing.report` before
each sandbox and at completion. The date is pinned across midnight and resume;
the report includes the current hourly interval and all workspace usage before
credits. It checkpoints every image/row and stops if billing cannot be read.
Accounted spend is the greater of cumulative runtime/build reservations or
observed provider usage **plus retained build margins**. Lower delayed
observations cannot reduce the ledger. Consequently it may stop before all images fit within the budget;
do not reset the ledger to work around that stop. Image-builder charges can be
delayed, and local reservations cannot enforce a provider spending cap.
Without the billing option, preflight stops after each image for manual
reconciliation via `--resume --observed-total-usd VALUE`.

After all 89 preflights pass and their final usage is reconciled, use the following
**separately inference-approved** command. Inject `TYPESAFE_API_KEY` securely in the
process environment first; never put its value in commands or files:

```sh
/home/ubuntu/harbor-venv/bin/python -m evals.modal_runner run \
  --benchmark-source "$BENCHMARK" --plan "$PLAN" \
  --preflight /home/ubuntu/jev-modal-preflight-v4 \
  --evidence /home/ubuntu/jev-modal-full-v4 \
  --budget-usd "$MODAL_BUDGET_USD" --billing-start-date "$MODAL_BILLING_START" \
  --approve-modal-compute --approve-inference
```

This budget includes the preflight ledger. Both arms reuse the preflight's same
Modal image ID and Linux/amd64 OCI manifest digest; mutable tag drift, registry
authorization/rate limits, layer/import failures, or failed evidence downloads
stop scheduling. Each scored row uses one fresh sandbox. Sources/tasks and the
plan identity must match on resume; failed/interrupted attempts require explicit
inspection and cannot silently rerun. The 178 planned rows and null rewards remain.

Sandbox lifetimes include setup (360 seconds), transfer (300), cleanup (90), a
60-second allowance, and original agent/verifier timeouts for full trials. The
task build timeout also bounds environment startup. Cleanup waits are bounded
even after evidence failures. There is one creation attempt, up to two explicitly
logged file-transfer/termination attempts for I/O timeouts, and no scored retries.
Modal SDK internal RPC retries are not observable as counters and are disclosed.

The SDK cannot request task storage capacity. Preflight records filesystem
statistics and verifies creation plus random read/write of a 32 GiB truncated
file, alongside the unmapped 10,240 MiB declaration. Modal's virtual filesystem
reported placeholder-sized capacity and full-size block counts in a real probe;
these statistics cannot prove physical free space or sparse allocation.
QEMU guest boot, VNC,
Valgrind/ptrace and actual task behavior remain runtime checks; version probes do
not certify them. Subscription model access and hook activation require inference.
Missing/corrupt evidence or unconfirmed termination prevents a completed score.
All downloaded evidence is private and must be sanitized before sharing, as below.
No credentials are put in image layers, named Modal Secrets or Volumes. SDK exec
uses direct environment values for the Jev key rather than Harbor's ephemeral
Secrets. Registry authentication uses an ephemeral Secret handle passed only to
`Image.from_registry(secret=...)`; it is never attached to a sandbox or exec.

### Authenticated registry and interleaved campaign

Create a short-lived Docker Hub **Public Repo Read-only** token through the
official account UI. Store `{"username": "...", "token": "..."}` in an owned
mode-600 file inside a mode-700 directory outside the repository and evidence.
Set `JEV_EVAL_DOCKER_AUTH_FILE` to its path. Values are read only by the controller:
Basic authentication obtains a pull-scoped Docker Hub bearer token, and Modal's
registry importer receives a private ephemeral registry-auth handle. Neither
credential is included in trial configuration, logs, evidence, agent environment,
verifier environment, or image layers. Invalid configured credentials fail closed.

The `campaign` command runs each task's preflight followed immediately by its
two arms, preserving the plan's alternating arm order and all 178 scored rows.
Successful preflights can be adopted from an earlier run with `--seed-preflight`.
This is an explicit new campaign with newly frozen harness provenance; production,
task, dependency and agent settings must match. Adoption rechecks evidence hashes,
image identity and confirmed termination. Old failed preflight rows remain in
the copied seed provenance; new setup attempts are separate. No scored results
are imported or retried. The first arm resolves the seed's tag again and rejects
drift; subsequent arms use the same verified immutable Modal image ID.

For this campaign, the $3.56 prior reservation rounds up the earlier $1.74 setup
reserve plus v4's $1.81927 ledger. It remains held, including while delayed
provider charges arrive. Build/import prices remain unknown and separately
reserved at $0.25 per newly imported image. This is conservative local accounting,
not a provider-enforced $30 cap.

```sh
export JEV_EVAL_DOCKER_AUTH_FILE="$HOME/.jev-docker-auth/registry.json"
export JEV_EVAL_AUTH_MODE=subscription
export JEV_EVAL_CLAUDE_AUTH_DIR="$HOME/.jev-claude-auth/.claude"
export MODAL_PROFILE=jev-terminal-bench
# Inject TYPESAFE_API_KEY privately before the campaign command.
python -m evals.modal_runner plan \
  --benchmark-source "$BENCHMARK" --plan "$HOME/jev-modal-execution-plan-v5"
python -m evals.modal_runner campaign \
  --benchmark-source "$BENCHMARK" --plan "$HOME/jev-modal-execution-plan-v5" \
  --seed-preflight "$HOME/jev-modal-preflight-v4" \
  --evidence "$HOME/jev-modal-campaign-v5" \
  --budget-usd 30 --prior-accounted-usd 3.56 --build-reserve-usd 0.25 \
  --billing-start-date 2026-09-18 --approve-modal-compute --approve-inference
```

The campaign stores setup checkpoints in `preflight-progress.json` and scored
checkpoints in `progress.json`. Both share one budget ledger and stop together
on access, registry, setup, evidence or budget failures. Use `--resume` only with
an unchanged identity and entirely pending/finished checkpoints. Preserve all
prior evidence directories unchanged.

### Subscription refresh and explicit continuation

Modal sandboxes copy the controller's official login into private runtime storage.
Claude can refresh that copy during setup or inference. Before termination the
provider downloads only `.credentials.json` into a private temporary directory
outside evidence, validates its refresh state, and atomically replaces the
controller copy. It refuses expired, malformed, or concurrently replaced state.
This uses the existing transfer-time allowance; evidence retrieval and termination
still run when refresh-state retrieval fails. Only expiry, change, and failure
metadata enter the lifecycle evidence. Failed writeback stops further scheduling
without discarding any scored result.

For a stopped campaign, use a new clean plan and evidence directory plus
`--continue-from`. Frozen production, task, model, and CLI settings must match.
Verified scored rows are referenced with their original evidence hashes and
harness revision, never rerun. A setup failure with no agent execution is labeled
as a new setup attempt before its first agent attempt. The original campaign
remains unchanged. A fresh no-inference subscription preflight on the first
cached image must pass before any missing scored row is scheduled.

```sh
chmod 700 "$JEV_EVAL_CLAUDE_AUTH_DIR"
python -m evals.modal_runner plan \
  --benchmark-source "$BENCHMARK" --plan "$HOME/jev-modal-execution-plan-v7"
python -m evals.modal_runner campaign \
  --benchmark-source "$BENCHMARK" --plan "$HOME/jev-modal-execution-plan-v7" \
  --seed-preflight "$HOME/jev-modal-campaign-v5" \
  --continue-from "$HOME/jev-modal-campaign-v5" \
  --evidence "$HOME/jev-modal-campaign-v7" \
  --budget-usd 30 --prior-accounted-usd 4.10 --build-reserve-usd 0.25 \
  --billing-start-date 2026-09-18 --approve-modal-compute --approve-inference
```

The example rounds the v6 cumulative reservation up to $4.10. Reconcile any later
setup spending before reusing it; it is not the actual provider bill.

### Parallel campaigns and a small checkpoint

Campaigns accept `--concurrency 1..8` (default 1). Each wave takes at most one
ready row from each task: verified preflight, then the two arms in the frozen
order. The continuation's fresh subscription recheck completes alone before
any other row. Arms are instance-local, so overlapping setup cannot change
another agent's plugin selection. Per-sandbox resources, prompts and limits
remain unchanged.

The controller reserves the whole wave before starting it, associates runtime
settlements with the individual ledger entries, and reads provider billing
after the wave drains. A failure prevents another wave; already-started trials
finish and retain their evidence. Create `PAUSE` in the evidence directory to
stop after the current wave without interrupting an agent attempt.

Parallel waves require the private access expiry to exceed every selected
trial's full build/runtime bound plus ten minutes. Near expiry the runner falls
back to one trial so a runtime refresh can be checkpointed without concurrent
writers. Unexpected competing credential updates still fail closed. This
does not bypass Claude subscription limits; access failures stop scheduling.

Use `--checkpoint-tasks 10` to save `small-results.json` once the first ten
manifest tasks finish both arms. These are the first tasks in alphabetical
manifest order, not a representative random sample. The full campaign continues
and never reruns them merely to produce the checkpoint.

`--no-budget-limit` replaces the local credit ceiling only with explicit user
authorization. It cannot be combined with `--budget-usd`. Provider usage,
runtime reservations, unknown image-build margins and billing failures are
still tracked; provider billing settings are not changed. For example:

```sh
python -m evals.modal_runner campaign \
  --benchmark-source "$BENCHMARK" --plan "$NEW_PLAN" \
  --seed-preflight "$PREVIOUS_EVIDENCE" --continue-from "$PREVIOUS_EVIDENCE" \
  --evidence "$NEW_EVIDENCE" --prior-accounted-usd "$PRIOR_RESERVATION" \
  --concurrency 3 --checkpoint-tasks 10 --no-budget-limit \
  --build-reserve-usd 0.25 --billing-start-date "$BILLING_START" \
  --approve-modal-compute --approve-inference
```

The observer adapts `tests/fixtures/long-session-observer`. It never modifies
requests/results and never captures HTTP headers. It captures activation,
started/completed Jev requests with response usage/latency, production log
messages, Bash results, and copies of the production original-output archives
under Harbor's agent logs. Native Claude transcripts remain authoritative for
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
