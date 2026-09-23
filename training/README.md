# Kev-0.8B retention fine-tuning

These scripts prepare a separate Kev decision model using SWE-Pruner Pro labels.
They do not call Jev or change production pruning behavior.

## Data policy

`prepare.mts` uses the production state builder, question wording, history splitter
and 20-line chunks. One source-selected line protects its whole chunk. Protected
diagnostics and uncertain annotations remain KEEP. Other omitted chunks are only
proposed DROP candidates, never automatic negative labels.

Only the task, preceding history, command and output enter model inputs.
`next_turn`, annotation reasoning, confidence and selected-line metadata do not
affect the state or the deterministic request-window selection. Long individual
lines that production would wrap are excluded to avoid corrupting source labels.
One history segment and one request window are sampled per response; the reviewer
must retain anything whose relevance is uncertain without the other segments.

Repository identity is required. The converter recognizes Multi-SWE issue IDs and
`owner_repository_prNUMBER` IDs. Unknown corpus families are rejected and counted,
rather than treating their trajectory IDs as independent repositories. Related
issues and attempts stay together through a deterministic repository split.

The pinned corpus declares Apache-2.0 on its
[dataset card](https://huggingface.co/datasets/ayanami-kitasan/swe-pruner-pro-training-corpus/tree/6bd52ba1d430eebcd6262a4147c7243cb2e8dd1b).
Its card names ByteDance-Seed/Multi-SWE-bench_trajs as the origin; the downloaded
file also contains other identifier families. Preserve the source attribution
and check issue overlap before any later SWE-bench evaluation.

The current conversion selects **2,290 responses from 496 repositories**, with
7,057 chunk questions and 1,452 proposed drops. Of 22,609 source rows, 16,554 have
unknown repository identifiers, 3,764 are otherwise excluded, and one duplicates a
state. These are unreviewed candidates. None passes the production over-10,000-token
activation condition, so this corpus alone cannot establish production savings
or safety on long outputs.

All 7,057 questions passed the pinned Kev tokenizer's 6,144-state-token admission
check without truncation: 5,117 train, 748 calibration, 599 development and 593
locked-test candidates. Final class counts depend on the policy review.

## Prepare and review

Run the TypeScript commands from this repository after `npm ci`. Keep generated
data and API credentials outside git. The output files must be new.

```bash
DATA="$HOME/pruner-data"
mkdir -p "$DATA"
curl -fL \
  https://huggingface.co/datasets/ayanami-kitasan/swe-pruner-pro-training-corpus/resolve/6bd52ba1d430eebcd6262a4147c7243cb2e8dd1b/training_corpus_22k.jsonl \
  -o "$DATA/source.jsonl"
npx tsx training/prepare.mts \
  --input "$DATA/source.jsonl" --out "$DATA/candidates.jsonl" --limit 5000
```

Inspect the adjacent preparation report before proceeding. The limit is a maximum,
not a promise that enough eligible records exist.

Provision `ANTHROPIC_API_KEY` in the process environment, then run:

```bash
npx tsx training/review.mts --provider anthropic \
  --input "$DATA/candidates.jsonl" --out "$DATA/raw-reviews.jsonl" \
  --budget 10 --limit 5000
npx tsx training/audit.mts --candidates "$DATA/candidates.jsonl" \
  --reviews "$DATA/raw-reviews.jsonl" --out "$DATA/reviews.jsonl"
```

Review defaults to Claude Sonnet 5 with a forced, strict-schema tool response and a
conservative retention policy. The optional `--provider openai` selects
`gpt-4.1-mini-2025-04-14` and requires `OPENAI_API_KEY`. The returned model identity
is recorded alongside policy hash, candidate hash, DROP rationales and token costs.
Only proposed-drop questions are sent, with the complete sampled state retained.
Empty DROP lists are valid. Labels are model-reviewed supervision, not human
ground truth. Review all proposed critical-diagnostic losses independently before
using an evaluation result to approve deployment.

The audit vetoes model-approved losses of warnings, tracebacks, final exit
statuses, diffs, source/configuration references, numeric outputs and test
environment details. It retains the raw review hash and each veto reason.
These checks were added after a training-partition audit found Claude calling
protected information "repetitive noise". They supplement review; they do not
prove that all remaining negatives are correct. Records whose proposed drops
are all protected by these checks need no provider call.

The request ledger reserves an upper cost bound before each API call. Failed or
interrupted attempts retain that reservation when resumed. The same command resumes
completed reviews without repeating them and refuses changed candidates. Do not
delete the attempts ledger to bypass the budget. HTTP errors stop the run without
automatic retries; an unfunded account cannot complete review.

Request bounds use UTF-8 byte counts plus framing overhead and maximum output
tokens. Actual costs use returned token usage and the documented standard rates:
Claude Sonnet 5 $2/$10 and GPT-4.1 mini $0.40/$1.60 per million input/output tokens.
Recheck provider pricing before rerunning.

## Freeze a new suite

Use the Python environment from
[Kev at 84f23b3](https://github.com/jaredpalmer/kev/commit/84f23b3752c597827c2f05b712768f50ea5d882f)
(`uv sync --locked` in that checkout, using its Python 3.13 selection). Set `KEV_CHECKOUT` to its
absolute directory. This step loads checkpoint metadata and the actual tokenizer,
but does not run GPU training.

Apply the included compatibility patch before using Kev's study runner:

```bash
git -C "$KEV_CHECKOUT" apply --check --unidiff-zero "$PWD/training/kev-context.patch"
git -C "$KEV_CHECKOUT" apply --unidiff-zero "$PWD/training/kev-context.patch"
```

The pinned runner otherwise evaluates with its default 384-token state limit,
ignoring the suite's larger admission context. The patch makes development,
transfer and locked-test evaluation respect each suite's declared context. Its
modified source hashes are recorded by the study.

```bash
SUITE="$KEV_CHECKOUT/evals/external/pruner-v1"
"$KEV_CHECKOUT/.venv/bin/python" training/freeze.py \
  --candidates "$DATA/candidates.jsonl" --reviews "$DATA/reviews.jsonl" \
  --kev "$KEV_CHECKOUT" --out "$SUITE"
"$KEV_CHECKOUT/.venv/bin/python" -c \
  "from kev.experiment import load_plan; print(load_plan('$SUITE', '$SUITE/plan.json'))"
```

Optionally pass `--seed-data PATH_TO_SEED_BUNDLE` to include the previously supplied
policy seed. Its inspectable test examples go to `regression.jsonl`, outside the
new locked test. The new suite also contains 2,000 deterministic replay records
from Kev's permitted decision-v7 **training** partition.

Freezing verifies review hashes and negative rationales; applies Kev's tokenizer
admission with a 6,144-token state budget and no truncation; rejects states duplicated
across partitions; and requires both retention classes in every external split.
Raw reviews, unknown audit versions and labels that contradict audit vetoes are
rejected. Supply the audited review file.
It writes checksums, provenance, rejection counts, a manifest and a validated plan
to a new directory. Never overwrite a frozen suite.

## Modal run

Authenticate through Modal's official CLI flow and verify the intended profile.
Run the following from the pinned Kev checkout, after inspecting the frozen
manifest and confirming enough reviewed examples survived context admission:

```bash
export KEV_APP_NAME=kev-pruner-research
export KEV_GPU=H100
export MODAL_IMAGE_BUILDER_VERSION=2025.06
uv run modal deploy modal_app.py
uv run modal run modal_app.py::study \
  --suite evals/external/pruner-v1 \
  --plan evals/external/pruner-v1/plan.json \
  --name pruner-v1-first --budget 30 --timeout 5400
```

Use a new immutable study name for any subsequent attempt. Run one training job at a
time. Independent baseline evaluation can use another GPU; count both admission
bounds against the same experiment allowance. Inspect the printed compute bound and training throughput before
continuing; the launcher's admission bound excludes image builds, startup,
annotation and persistent storage. Track those separately within the experiment's
overall allowance.

The plan starts from pinned `jaredpalmer/kev-0.8b` and updates its existing LoRA
adapters and pointer head: one epoch, cross-entropy, learning rate `1e-5`,
batch one, accumulation eight, BF16 autocast, FP32 frozen weights.

Pull artifacts with `uv run modal run modal_app.py::pull --name pruner-v1-first`.
Score the pinned parent checkpoint without another training run:

```bash
uv run modal run modal_app.py::study \
  --suite evals/external/pruner-v1 --plan '' \
  --existing jaredpalmer/kev-0.8b@54f4f8777356cd5bbbb6c6919c657f26e6f2f6d8 \
  --name pruner-v1-parent --budget 5 --timeout 2400
uv run modal run modal_app.py::pull --name pruner-v1-parent
```

Fit temperature on calibration data, select model and retention threshold on
development data, then read the locked test once. Compare against released Kev
and deterministic retention rules at matched necessary-chunk deletion risk.
Report false deletion, realized token reduction, calibration, latency and cost.
Long-output and end-to-end agent preservation checks remain required before
production integration.

Use saved benchmark rows for the retention-specific report (from this repo):

```bash
"$KEV_CHECKOUT/.venv/bin/python" training/score.py \
  --suite "$SUITE" --rows "$TRIAL/development/rows.json" \
  --temperature "$CALIBRATED_TEMPERATURE" --out "$DATA/development-retention.json"
npx tsx training/rules.mts --input "$SUITE/development.jsonl" \
  --out "$DATA/rules-development-rows.json"
"$KEV_CHECKOUT/.venv/bin/python" training/score.py \
  --suite "$SUITE" --rows "$DATA/rules-development-rows.json" \
  --out "$DATA/rules-development-retention.json"
```

Set `TRIAL` to the pulled trial directory and `CALIBRATED_TEMPERATURE` to the
temperature in its calibration artifact. Score each model with its own
calibration temperature. The study writes that temperature to
`calibration/temperature.json`; it does not replace the checkpoint's inherited
serving temperature. For subsequent inference, set
`KEV_TEMPERATURE="$CALIBRATED_TEMPERATURE"` explicitly or create a separate
calibrated export, preserving the original study checkpoint and its hashes.

The report includes deletion-error
denominators, low-probability reliability bins, and repository, source,
language, command, confidence and length slices. Token reduction is a conditional
estimate over sampled chunks, not realized production savings: the production
activation gate, separator overhead and protected-line overrides are excluded.
After recording development selection, `--split test --allow-test` scores a
locked test at the selected `--cutoff`; it does not search test thresholds.

## Local checks

```bash
npm test
npm run typecheck
npm run build
npx tsc -p training/tsconfig.json
"$KEV_CHECKOUT/.venv/bin/python" -m pytest training -q
uvx --from ruff==0.12.12 ruff check training
uvx --from pyright==1.1.405 pyright \
  --project "$KEV_CHECKOUT" --pythonpath "$KEV_CHECKOUT/.venv/bin/python" \
  training
```

The Python unit tests mock checkpoint/tokenizer access and use synthetic labels.
Passing them does not validate real training labels or establish model quality.
