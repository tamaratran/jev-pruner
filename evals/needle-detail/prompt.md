---
max_turns: 8
allowed_tools: [Bash, Read, Grep]
runs: 3
tags: [pruner]
---

Run exactly this command, then tell me the serial number of item-177:

```
for i in $(seq 1 300); do echo "item-$i qty=$((i%50)) bin=A$((i%20)) status=in-stock location=aisle-$((i%12))"; done | sed '177s/.*/item-177 qty=13 bin=Z9 serial=SN-88431-XQ status=quarantined/'
```
