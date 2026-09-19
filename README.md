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
automatically. See the [Claude setup guide](GUIDE.md#claude-code-install) for details.

## Codex

Codex uses a wrapper you invoke through a skill. It doesn't trim every shell command
automatically. Follow the [Codex setup guide](GUIDE.md#codex) to install it, configure
your API key, and trust the hook. Then ask Codex:

```text
$jev-pruner Run npm test through the pruner and report the test results.
```

## More

See the [full guide](GUIDE.md) for configuration, output recovery, privacy details,
tests, and the demo.

To check a change locally, run `npm test`, `npm run typecheck`, and `npm run build`.
