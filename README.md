# jev-pruner

Trim long command output before Claude Code or Codex reads it. Jev picks what
to keep. The kept text stays word for word, and the agent can read the saved
output if it needs more.

Only output over 10,000 estimated tokens is eligible. The pruner keeps recognized
code, docs, errors, and results. If pruning fails, the original output passes through.

Jev sends command output and conversation context to TypeSafe. You'll need a
[TypeSafe API key](https://console.typesafe.ai/settings/keys) and paid API credits.
Your Claude or Codex subscription doesn't cover Jev. The pruner doesn't redact secrets.

## Claude Code

Use Claude Code with function-hook support. Set `TYPESAFE_API_KEY` and
`CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your environment, then run:

```sh
claude plugin marketplace add tamaratran/jev-pruner
claude plugin install fast-jev-output@fast-jev-output
```

Start a new session and use Claude as usual. The plugin trims eligible Bash output
automatically.

## Codex

Codex uses a wrapper you invoke through a skill. It doesn't trim every shell command
automatically. With Node.js 18+, Git, and Codex CLI 0.152.1 installed, run:

```sh
git clone https://github.com/tamaratran/jev-pruner.git
cd jev-pruner
npm ci
npm run build
codex plugin marketplace add "$PWD"
codex plugin add jev-pruner@jev-pruner-codex
```

Keep the checkout. Set `TYPESAFE_API_KEY` in your environment and sign in with
`codex login`. Start Codex in your project:

```sh
codex --sandbox workspace-write \
  -c sandbox_workspace_write.network_access=true \
  -c tool_output_token_limit=30000
```

Open `/hooks` and trust the `jev-pruner` hook. Make sure Codex's shell can access
your API key. Then ask:

```text
$jev-pruner Run npm test through the pruner and report the test results.
```

## Development

To check a change locally, run `npm test`, `npm run typecheck`, and `npm run build`.
