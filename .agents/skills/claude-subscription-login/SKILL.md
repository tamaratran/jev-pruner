---
name: claude-subscription-login
description: Complete an explicitly authorized official Claude subscription login on a Linux Devin Docker worker without inference or credential logging.
---

Use only when the user requests subscription login. Authentication does not
authorize a benchmark, smoke, or inference call.

1. Use the existing Chrome browser and its CDP endpoint at
   `http://localhost:29229`. Docker must already work, and the image must contain
   Claude Code 2.1.274. The helper needs Python `playwright` and `pexpect==4.9.0`.
2. Create a dedicated mode-700 auth home outside the repo and evidence. Do not
   read credential file contents or save an OAuth token as a Devin secret without
   separate permission.
3. Run the helper with explicit parameters:

   ```sh
   python login.py --image "$SMOKE_IMAGE" \
     --auth-home "$CLAUDE_AUTH_HOME" --email "$LOGIN_EMAIL"
   ```

   It starts `claude auth login --claudeai` in a temporary container, opens the
   official URL, and privately submits the official one-time callback code to
   the CLI. It never runs `claude -p`. No CLI output containing codes is logged.
4. Continue the official browser flow. Confirm the exact requested account
   identity in the Google UI before entering an authorized password using secure
   secret substitution. Pause for user verification or CAPTCHA in this Desktop.
   Never expose passwords or callback codes in messages/screenshots.
5. Read the helper's output after the user completes verification. It reports
   `Login successful` only when the official CLI does. Do not infer login success
   from the browser alone. The helper times out after 30 minutes.
6. Verify with `claude auth status --json` in a **fresh** container using only the
   private auth mount. Do not pass API keys, auth tokens, cloud-provider flags,
   custom headers, or an OAuth token override. Use `--setting-sources ''` and
   `--settings '{"forceLoginMethod":"claudeai"}'`. Report only selected status
   fields, not the entire config or credential contents.
7. Confirm no benchmark containers/processes are running. Keep subsequent
   evaluations paused unless separately authorized. See `evals/README.md` for
   read-only mounting, private per-trial auth storage, and reporting caveats.

Verified on Linux with the official Google login, user-completed 2FA/CAPTCHA,
Claude Code 2.1.274, and Max subscription status. Status is local authentication
selection, not a test of model availability or remaining subscription allowance.
