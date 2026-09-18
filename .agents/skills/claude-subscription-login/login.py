import argparse
import asyncio
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import pexpect
from playwright.async_api import async_playwright


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--auth-home", type=Path, required=True)
    parser.add_argument("--email", required=True)
    args = parser.parse_args()
    auth_home = args.auth_home.expanduser().resolve(strict=True)
    if auth_home.stat().st_mode & 0o077:
        raise ValueError("Use a private auth directory with mode 700")
    child = pexpect.spawn(
        "docker",
        [
            "run",
            "--rm",
            "-it",
            "--name",
            "jev-subscription-login",
            "--network",
            "host",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--env",
            "HOME=/claude-auth",
            "--env",
            "CLAUDE_CONFIG_DIR=/claude-auth/.claude",
            "--env",
            "DISABLE_TELEMETRY=1",
            "--env",
            "DISABLE_ERROR_REPORTING=1",
            "--env",
            "DISABLE_AUTOUPDATER=1",
            "--mount",
            f"type=bind,src={auth_home},dst=/claude-auth",
            args.image,
            "claude",
            "auth",
            "login",
            "--claudeai",
            "--email",
            args.email,
        ],
        encoding="utf-8",
        dimensions=(40, 2000),
        echo=False,
    )
    try:
        child.expect(
            r"https://claude\.com/cai/oauth/authorize\?[^\x00-\x20\x7f-\x9f]+",
            timeout=30,
        )
        url = re.sub(r"\x1b\[[0-9;]*m", "", child.match.group(0))
        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(
                "http://localhost:29229"
            )
            context = browser.contexts[0]
            page = context.pages[0]
            await page.goto(url)
            print("Official Claude subscription login opened in Desktop.", flush=True)
            started = time.monotonic()
            submitted = False
            while time.monotonic() - started < 1800:
                for candidate in context.pages:
                    parsed = urlparse(candidate.url)
                    if (
                        parsed.hostname == "platform.claude.com"
                        and parsed.path == "/oauth/code/callback"
                    ):
                        button = candidate.get_by_role(
                            "button", name=re.compile("copy", re.IGNORECASE)
                        )
                        if not submitted and await button.count() == 1:
                            await context.grant_permissions(
                                ["clipboard-read", "clipboard-write"]
                            )
                            await button.click()
                            code = await candidate.evaluate(
                                "navigator.clipboard.readText()"
                            )
                            if (
                                isinstance(code, str)
                                and 10 < len(code) < 1000
                                and "\n" not in code
                            ):
                                child.sendline(code)
                                await candidate.evaluate(
                                    "navigator.clipboard.writeText('')"
                                )
                                submitted = True
                                print(
                                    "Official callback code submitted privately to Claude CLI.",
                                    flush=True,
                                )
                try:
                    status = child.expect(
                        ["Login successful", "Authentication failed", pexpect.EOF],
                        timeout=0,
                    )
                    if status == 0:
                        print("Claude CLI reports Login successful.", flush=True)
                        child.expect(pexpect.EOF, timeout=20)
                        for candidate in context.pages:
                            if urlparse(candidate.url).path == "/oauth/code/callback":
                                await candidate.goto(
                                    "https://code.claude.com/docs/en/authentication"
                                )
                        return
                    if status == 1:
                        raise RuntimeError(
                            "Official CLI reported authentication failure"
                        )
                    if status == 2:
                        raise RuntimeError("Login ended before success")
                except pexpect.TIMEOUT:
                    pass
                await asyncio.sleep(1)
            raise TimeoutError("Login not completed within 30 minutes")
    except (pexpect.TIMEOUT, pexpect.EOF):
        raise RuntimeError(
            "Official CLI login ended unexpectedly; retry login"
        ) from None
    finally:
        if child.isalive():
            child.sendcontrol("c")
            child.close()


if __name__ == "__main__":
    asyncio.run(main())
