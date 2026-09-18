#!/usr/bin/env bash
set -euo pipefail

if [[ "${JEV_EVAL_AUTH_MODE:-api}" != api ]]; then
  printf '%s\n' 'This smoke launcher supports API mode only; refusing API fallback.' >&2
  exit 1
fi

: "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY}"
: "${TYPESAFE_API_KEY:?Set TYPESAFE_API_KEY}"
: "${SMOKE_IMAGE:?Set SMOKE_IMAGE to an image with Claude Code 2.1.274}"
: "${EVIDENCE_DIR:?Set EVIDENCE_DIR to an absolute directory outside the repo}"
repo="$(git rev-parse --show-toplevel)"
prompt='Run exactly once: node /plugin/tests/fixtures/noisy-build.mjs 1
Then report only whether deployment can proceed. Use Bash only. Do not read archives.'
mkdir -p "$EVIDENCE_DIR"
for arm in control plugin; do
  mkdir -p "$EVIDENCE_DIR/$arm"
  flags=(--plugin-dir /plugin/evals/observer)
  if [[ "$arm" == plugin ]]; then flags+=(--plugin-dir /plugin); fi
  docker run --rm --workdir /workspace \
    --env ANTHROPIC_API_KEY --env TYPESAFE_API_KEY \
    --env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
    --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 --env DISABLE_AUTOUPDATER=1 \
    --env CLAUDE_CONFIG_DIR=/logs/agent/sessions --env IS_SANDBOX=1 \
    --mount "type=bind,src=$repo,dst=/plugin,readonly" \
    --mount "type=bind,src=$EVIDENCE_DIR/$arm,dst=/logs/agent" \
    "$SMOKE_IMAGE" claude -p "$prompt" \
    --model claude-sonnet-5 --max-budget-usd 1 --max-turns 3 --effort high \
    --verbose --output-format stream-json --permission-mode bypassPermissions \
    --setting-sources '' --strict-mcp-config --tools Bash \
    --settings '{"enabledPlugins":{"plugin-authoring@builtin":false}}' "${flags[@]}" \
    > "$EVIDENCE_DIR/$arm/events.jsonl" 2> "$EVIDENCE_DIR/$arm/stderr.txt"
done
