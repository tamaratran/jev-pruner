---
name: modal-login
description: Authenticate an explicitly authorized Modal CLI through existing Chrome without logging token values.
---

Requires Linux, the existing Chrome CDP endpoint at `http://localhost:29229`,
Modal 1.5.1, and Python Playwright. Use only after the user authorizes access to
their Modal account. Login alone does not authorize compute or deployments.

1. Sign into `https://modal.com/login` using the user's authorized identity.
   Existing GitHub sign-in may require a GitHub Mobile approval from the user.
   Confirm the intended workspace; a default organization can differ from the
   user's personal workspace.
2. Create a mode-700 private directory outside the repository and evidence.
   With `umask 077`, run `BROWSER=true modal token new --profile PROFILE --activate`
   in a background shell, redirecting stdout/stderr into a private log there.
   Never print or attach that log, token-flow URLs/codes, or `.modal.toml`.
3. Run `python open_cli_login.py PRIVATE_LOG` using Python with Playwright.
   This opens the CLI-generated official URL in existing Chrome without printing
   it. Select the authorized workspace and click Authorize.
4. Wait for the CLI process to finish successfully, restrict `.modal.toml` to
   mode 600, and verify `modal profile current`. An authorized compute preflight
   can verify actual account access; do not launch inference merely for login.
5. Keep account state out of commits, artifacts, and environment blueprints.
   Saving the token as a reusable Devin secret requires separate permission.
