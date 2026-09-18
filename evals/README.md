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

**Known limitation:** an eval run gets a fresh HOME and a scrubbed environment,
so `TYPESAFE_API_KEY` never reaches the hook and the plugin passes output
through untouched — the `pruned` indicators fail and the scores only show that
the plugin does no harm when it is inert. Exercising the pruning path from the
eval harness needs a key source the sandbox preserves.
