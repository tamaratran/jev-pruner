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

Provision `OPENAI_API_KEY` in the process environment, then run:

```bash
npx tsx training/review.mts \
  --input "$DATA/candidates.jsonl" --out "$DATA/reviews.jsonl" \
  --budget 10 --limit 5000
```

Review uses `gpt-4.1-mini-2025-04-14` with a conservative retention policy. It
records model, policy hash, candidate hash, DROP rationales and token costs.
Empty DROP lists are valid. Labels are model-reviewed supervision, not human
ground truth. Review all proposed critical-diagnostic losses independently before
using an evaluation result to approve deployment.

The request ledger reserves an upper cost bound before each API call. Failed or
interrupted attempts retain that reservation when resumed. The same command resumes
completed reviews without repeating them and refuses changed candidates. Do not
delete the attempts ledger to bypass the budget. HTTP errors stop the run without
automatic retries; an unfunded account cannot complete review.

## Freeze a new suite

Use the Python environment from
[Kev at 84f23b3](https://github.com/jaredpalmer/kev/commit/84f23b3752c597827c2f05b712768f50ea5d882f)
(`uv sync --python 3.12 --locked` in that checkout). Set `KEV_CHECKOUT` to its
absolute directory. This step loads checkpoint metadata and the actual tokenizer,
but does not run GPU training.

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
It writes checksums, provenance, rejection counts, a manifest and a validated plan
to a new directory. Never overwrite a frozen suite.

## Modal run

Authenticate through Modal's official CLI flow and verify the intended profile.
Run the following from the pinned Kev checkout, after inspecting the frozen
manifest and confirming enough reviewed examples survived context admission:

```bash
export KEV_APP_NAME=kev-pruner-research
export KEV_GPU=H100
uv run modal deploy modal_app.py
uv run modal run modal_app.py::study \
  --suite evals/external/pruner-v1 \
  --plan evals/external/pruner-v1/plan.json \
  --name pruner-v1-first --budget 30 --timeout 5400
```

Use a new immutable study name for any subsequent attempt. Run one GPU job at a
time. Inspect the launcher's printed compute bound and training throughput before
continuing; the launcher's admission bound excludes image builds, startup,
annotation and persistent storage. Track those separately within the experiment's
overall allowance.

The plan starts from pinned `jaredpalmer/kev-0.8b` and updates its existing LoRA
adapters and pointer head: one epoch, cross-entropy, learning rate `1e-5`,
batch one, accumulation eight, BF16 autocast, FP32 frozen weights.

Pull artifacts with `uv run modal run modal_app.py::pull --name pruner-v1-first`.
Fit temperature on calibration data, select model and retention threshold on
development data, then read the locked test once. Compare against released Kev
and deterministic retention rules at matched necessary-chunk deletion risk.
Report false deletion, realized token reduction, calibration, latency and cost.
Long-output and end-to-end agent preservation checks remain required before
production integration.

## Local checks

```bash
npm test
npm run typecheck
npm run build
npx tsc -p training/tsconfig.json
"$KEV_CHECKOUT/.venv/bin/python" -m pytest training/test_freeze.py -q
uvx --from ruff==0.12.12 ruff check training
uvx --from pyright==1.1.405 pyright \
  --project "$KEV_CHECKOUT" --pythonpath "$KEV_CHECKOUT/.venv/bin/python" \
  training/freeze.py training/test_freeze.py
```

The Python unit tests mock checkpoint/tokenizer access and use synthetic labels.
Passing them does not validate real training labels or establish model quality.
