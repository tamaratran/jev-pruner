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

**Known limitation: the suite cannot exercise pruning.** Function hooks do not
run inside `claude plugin eval`. A debug write placed as the first statement of
the `tool.call` hook never executed, and the tool result reached the agent at
its full length, on both Claude Code 2.1.274 and 2.1.277, with the plugin
loaded and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set inside the run. So the
`pruned` indicators fail and the scores only show that the plugin does no harm
while it is inert.

An eval run also gets a fresh HOME and a scrubbed environment, so
`TYPESAFE_API_KEY` and `pluginConfigs` from the user's settings never reach the
hook. `getApiKey` therefore also reads `EVAL_TYPESAFE_API_KEY`, which the
harness does pass through from the operator's shell:

```sh
EVAL_TYPESAFE_API_KEY="$TYPESAFE_API_KEY" claude plugin eval . --trust-plugin --allow-tools Bash Read Grep
```

That key path is ready for when the harness runs hooks; today it changes
nothing.

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
