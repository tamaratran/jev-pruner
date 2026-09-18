# Eval suite

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
