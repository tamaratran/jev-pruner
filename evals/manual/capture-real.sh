#!/bin/bash
# Captures the real command output the real.mts sweep runs over. Run from the
# repo root; writes into $1 (default: a temp dir it prints).
set -u
OUT="${1:-$(mktemp -d)}"
mkdir -p "$OUT"
npx vitest run --reporter verbose > "$OUT/vitest.txt" 2>&1
cp src/output.ts /tmp/jev-output-keep.ts
printf '\nconst broken: number = "nope";\n' >> src/output.ts
npx tsc --noEmit -p tsconfig.json --listFiles > "$OUT/tsc.txt" 2>&1
cp /tmp/jev-output-keep.ts src/output.ts
npm ls --all > "$OUT/npmls.txt" 2>&1
git log --stat -n 40 > "$OUT/gitlog.txt" 2>&1
find node_modules -name "*.d.ts" 2>/dev/null | head -3000 > "$OUT/find.txt"
du -a node_modules 2>/dev/null | sort -rn | head -2000 > "$OUT/du.txt"
ls -laR node_modules/vitest > "$OUT/lsr.txt" 2>&1
curl -s -D - -o /dev/null https://api.github.com/rate_limit > "$OUT/curl.txt" 2>&1
for _ in $(seq 1 60); do curl -s -D - -o /dev/null https://example.com >> "$OUT/curl.txt" 2>&1; done
docker images -a > "$OUT/docker.txt" 2>&1; docker ps -a >> "$OUT/docker.txt" 2>&1
python3 -m pytest -v > "$OUT/pytest.txt" 2>&1 || true
echo "$OUT"
