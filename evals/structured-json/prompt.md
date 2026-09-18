---
max_turns: 6
allowed_tools: [Bash, Read, Grep]
runs: 3
tags: [pruner]
---

Run exactly this command, then tell me which team owns svc-77:

```
python3 -c "import json;print(json.dumps({'services':[{'id':i,'name':'svc-%d'%i,'port':8000+i,'owner':'payments-team' if i==77 else 'infra'} for i in range(120)]},indent=2))"
```
