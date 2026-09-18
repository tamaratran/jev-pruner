"""Open an official Modal CLI token flow without printing its private URL."""

import argparse
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("private_cli_log", type=Path)
    args = parser.parse_args()
    match = re.search(
        r"https://modal.com/token-flow/[^\s\x1b]+",
        args.private_cli_log.read_text(),
    )
    if match is None:
        raise SystemExit("Official CLI authorization URL not yet available")
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp("http://localhost:29229")
        page = browser.contexts[0].pages[-1]
        page.goto(match.group(), wait_until="domcontentloaded")
    print("Opened official Modal CLI authorization page")


if __name__ == "__main__":
    main()
