#!/usr/bin/env bash
set -euo pipefail

: "${TYPESAFE_API_KEY:?Set TYPESAFE_API_KEY}"
: "${EVIDENCE_DIR:?Set an absolute evidence directory outside the repo}"
harbor="${HARBOR_BIN:-harbor}"
repo="$(git rev-parse --show-toplevel)"
export PYTHONPATH="$repo${PYTHONPATH:+:$PYTHONPATH}"
auth_args=()
case "${JEV_EVAL_AUTH_MODE:-api}" in
  api)
    : "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY}"
    ;;
  subscription)
    : "${JEV_EVAL_CLAUDE_AUTH_DIR:?Set the private official Claude config directory}"
    auth_args=(--mounts "$(python3 "$repo/evals/auth.py")")
    ;;
  *)
    printf '%s\n' 'JEV_EVAL_AUTH_MODE must be api or subscription' >&2
    exit 1
    ;;
esac
[[ "$("$harbor" --version)" == 0.22.0 ]]
if [[ -n "$(git status --porcelain -- evals .claude-plugin hooks src)" ]]; then
  printf '%s\n' 'Commit evaluation and production sources before running.' >&2
  exit 1
fi
if compgen -G "$EVIDENCE_DIR/jobs/pilot-*" > /dev/null; then
  printf '%s\n' 'Use a fresh evidence directory; refusing to reuse pilot jobs.' >&2
  exit 1
fi
mkdir -p "$EVIDENCE_DIR/jobs"
git rev-parse HEAD > "$EVIDENCE_DIR/harness-commit.txt"
git diff --binary > "$EVIDENCE_DIR/harness-working.diff"
status=0
for task in build-cython-ext chess-best-move configure-git-webserver; do
  arms=(control plugin)
  if [[ "$task" == chess-best-move ]]; then arms=(plugin control); fi
  for arm in "${arms[@]}"; do
    export JEV_EVAL_ARM="$arm"
    if ! "$harbor" run -d terminal-bench@2.0 \
      --registry-url https://raw.githubusercontent.com/laude-institute/harbor/b83e7686999a18ba90a8603794d7d18d42cab010/registry.json \
      -i "$task" -a evals.harbor_agent:JevClaudeCode \
      -m anthropic/claude-sonnet-5 \
      --ak version=2.1.274 --ak max_budget_usd=3 --ak max_turns=80 \
      --ak reasoning_effort=high \
      -n 1 -k 1 -r 0 --timeout-multiplier 1.0 \
      --job-name "pilot-$task-$arm" --jobs-dir "$EVIDENCE_DIR/jobs" "${auth_args[@]}"; then
      status=1
    fi
  done
done
if ! python3 "$repo/evals/summarize.py" "$EVIDENCE_DIR"; then status=1; fi
exit "$status"
