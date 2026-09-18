---
max_turns: 6
allowed_tools: [Bash, Read, Grep]
runs: 3
tags: [pruner]
---

Run exactly this command, then tell me the two highest latency values it reports
and which workers they belong to:

```
for i in $(seq 1 300); do echo "2026-09-18 INFO worker-$((i%7)) request $i latency=$((i*3%900))ms"; done | sed '44s/.*/2026-09-18 INFO worker-5 request 44 latency=1840ms/' | sed '255s/.*/2026-09-18 INFO worker-2 request 255 latency=1795ms/'
```
