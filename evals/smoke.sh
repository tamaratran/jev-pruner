#!/usr/bin/env bash
set -euo pipefail

: "${TYPESAFE_API_KEY:?Set TYPESAFE_API_KEY}"
: "${SMOKE_IMAGE:?Set SMOKE_IMAGE to an image with Claude Code 2.1.274}"
: "${EVIDENCE_DIR:?Set EVIDENCE_DIR to an absolute directory outside the repo}"
repo="$(git rev-parse --show-toplevel)"
export PYTHONPATH="$repo${PYTHONPATH:+:$PYTHONPATH}"
production="$(python3 -c 'from evals.full import REPO; from evals.sources import production_root, production_provenance; production_provenance(REPO); print(production_root(REPO))')"
auth_args=()
settings='{"enabledPlugins":{"plugin-authoring@builtin":false}}'
prelude='unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'
case "${JEV_EVAL_AUTH_MODE:-api}" in
  api)
    : "${ANTHROPIC_API_KEY:?Set ANTHROPIC_API_KEY}"
    auth_args=(--env ANTHROPIC_API_KEY --env CLAUDE_CONFIG_DIR=/logs/agent/sessions)
    ;;
  subscription)
    source_auth="$(python3 -c 'from evals.auth import subscription_mounts; print(subscription_mounts()[0]["source"])')"
    auth_args=(--mount "type=bind,src=$source_auth,dst=/opt/jev-eval/login,readonly")
    settings='{"enabledPlugins":{"plugin-authoring@builtin":false},"forceLoginMethod":"claudeai"}'
    prelude="$(python3 -c 'from evals.auth import AUTH_OVERRIDES, AUTH_RUNTIME, prepare_subscription; print("unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC " + " ".join(AUTH_OVERRIDES) + "; export CLAUDE_CONFIG_DIR=" + AUTH_RUNTIME + "; " + prepare_subscription("/logs/agent") + " || exit 1; node /plugin/evals/check_auth.cjs > /logs/agent/auth-status.json")')"
    ;;
  *)
    printf '%s\n' 'JEV_EVAL_AUTH_MODE must be api or subscription' >&2
    exit 1
    ;;
esac
plugin_settings="$(python3 -c 'import json, sys; from evals.sources import plugin_options; print(json.dumps({**json.loads(sys.argv[1]), "pluginConfigs": {"fast-jev-output@inline": {"options": plugin_options()}}}, separators=(",", ":")))' "$settings")"
python3 -c '
import os
import sys
from pathlib import Path
evidence = Path(os.environ["EVIDENCE_DIR"])
repo = Path(sys.argv[1]).resolve()
if not evidence.is_absolute() or evidence.resolve().is_relative_to(repo):
    raise SystemExit("Use an absolute evidence directory outside the repo")
if evidence.exists():
    raise SystemExit("Use a new evidence directory")
' "$repo"
if [[ -n "$(git status --porcelain -- evals .claude-plugin hooks src tests/fixtures/noisy-build.mjs)" ]]; then
  printf '%s\n' 'Commit evaluation and production sources before running.' >&2
  exit 1
fi
prompt='Make exactly one Bash tool call in total, running this exact command:
node /plugin/tests/fixtures/noisy-build.mjs 1
Then report only whether deployment can proceed, based on the visible result.
If the result is insufficient, say so. Do not make any further tool calls,
inspect saved output or archives, or check the exit code in another command.'
prompt="${JEV_EVAL_SMOKE_PROMPT:-$prompt}"
mkdir -p "$EVIDENCE_DIR"
printf '%s\n' "$prompt" > "$EVIDENCE_DIR/prompt.txt"
git rev-parse HEAD > "$EVIDENCE_DIR/harness-commit.txt"
git -C "$production" rev-parse HEAD > "$EVIDENCE_DIR/production-commit.txt"
docker image inspect "$SMOKE_IMAGE" --format '{{.Id}}' > "$EVIDENCE_DIR/image-id.txt"
printf '%s\n' "${JEV_EVAL_AUTH_MODE:-api}" > "$EVIDENCE_DIR/auth-mode.txt"
for arm in control plugin; do
  mkdir -p "$EVIDENCE_DIR/$arm"
  flags=(--plugin-dir /plugin/evals/observer)
  arm_settings="$settings"
  if [[ "$arm" == plugin ]]; then
    flags+=(--plugin-dir /production)
    arm_settings="$plugin_settings"
  fi
  docker run --rm --workdir /workspace \
    "${auth_args[@]}" --env TYPESAFE_API_KEY \
    --env CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 \
    --env DISABLE_TELEMETRY=1 --env DISABLE_ERROR_REPORTING=1 --env DISABLE_AUTOUPDATER=1 \
    --env IS_SANDBOX=1 \
    --mount "type=bind,src=$repo,dst=/plugin,readonly" \
    --mount "type=bind,src=$production,dst=/production,readonly" \
    --mount "type=bind,src=$EVIDENCE_DIR/$arm,dst=/logs/agent" \
    "$SMOKE_IMAGE" bash -ec "$prelude"'
      test "$(claude --version)" = "2.1.274 (Claude Code)"
      exec claude "$@"
    ' -- -p "$prompt" \
    --model claude-sonnet-5 --max-budget-usd 1 --max-turns 3 --effort high \
    --verbose --output-format stream-json --permission-mode bypassPermissions \
    --setting-sources '' --strict-mcp-config --tools Bash \
    --settings "$arm_settings" "${flags[@]}" \
    > "$EVIDENCE_DIR/$arm/events.jsonl" 2> "$EVIDENCE_DIR/$arm/stderr.txt"
  python3 "$repo/evals/summarize.py" "$EVIDENCE_DIR/$arm" --smoke-arm "$arm"
done
