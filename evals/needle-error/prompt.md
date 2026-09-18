---
max_turns: 6
allowed_tools: [Bash, Read, Grep]
runs: 3
tags: [pruner]
---

Run exactly this command, then tell me in one sentence which build step failed and why:

```
for i in $(seq 1 320); do echo "2026-09-18 10:$((i%60)) INFO worker-$((i%7)) compiled module $i in $((i%400))ms"; done | sed '180s/.*/2026-09-18 10:06 ERROR worker-3 failed to link checkout_v2: undefined symbol parse_coupon_v2 (exit 1)/'
```
