import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from evals.summarize import summarize_smoke

REPO = Path(__file__).resolve().parents[1]


class SmokeTests(unittest.TestCase):
    def test_subscription_pilot_stops_after_invalid_first_trial(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth = root / "auth"
            auth.mkdir()
            (auth / ".credentials.json").write_text("dummy fixture")
            git = root / "git"
            git.write_text(
                '#!/bin/sh\nif [ "$1" = rev-parse ]; then printf "%s" "$REPO"; fi\n'
            )
            git.chmod(0o700)
            harbor = root / "harbor"
            harbor.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                "from pathlib import Path\n"
                'if sys.argv[1] == "--version":\n'
                '    print("0.22.0")\n'
                "else:\n"
                '    with open(os.environ["CAPTURE"], "a") as output:\n'
                '        output.write("trial\\n")\n'
                '    job = sys.argv[sys.argv.index("--job-name") + 1]\n'
                '    (Path(os.environ["EVIDENCE_DIR"]) / "jobs" / job).mkdir()\n'
            )
            harbor.chmod(0o700)
            capture = root / "calls"
            result = subprocess.run(
                ["bash", "evals/pilot.sh"],
                cwd=REPO,
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "REPO": str(REPO),
                    "CAPTURE": str(capture),
                    "HARBOR_BIN": str(harbor),
                    "JEV_EVAL_AUTH_MODE": "subscription",
                    "JEV_EVAL_CLAUDE_AUTH_DIR": str(auth),
                    "EVIDENCE_DIR": str(root / "evidence"),
                    "TYPESAFE_API_KEY": "fake-jev",
                },
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(capture.read_text(), "trial\n")
            self.assertIn("stopping pilot", result.stderr)

    def test_plugin_presence_without_trimming_does_not_pass_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with patch(
                "evals.summarize.summarize_agent",
                return_value={
                    "model": "claude-sonnet-5",
                    "measurement_issues": [],
                    "bash_calls_observed": 1,
                    "jev_responses": 0,
                    "jev_http_statuses": [],
                    "pruned_results_in_transcript": 0,
                    "net_chars_saved": 0,
                },
            ):
                row = summarize_smoke(Path(directory), "plugin")
                self.assertIn(
                    "Smoke did not prove real Jev trimming", row["measurement_issues"]
                )

    def test_subscription_smoke_never_passes_api_key_and_preflights_first(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            auth = root / "auth"
            auth.mkdir()
            (auth / ".credentials.json").write_text("dummy fixture")
            for name, script in {
                "git": (
                    "#!/bin/sh\n"
                    'if [ "$1" = rev-parse ]; then\n'
                    '  if [ "$2" = --show-toplevel ]; then printf "%s" "$REPO";\n'
                    '  else printf "test-commit"; fi\n'
                    "fi\n"
                ),
                "docker": (
                    "#!/usr/bin/env python3\n"
                    "import json, os, sys\n"
                    'if sys.argv[1] == "image":\n'
                    '    print("test-image")\n'
                    "else:\n"
                    '    with open(os.environ["CAPTURE"], "w") as output:\n'
                    "        json.dump(sys.argv[1:], output)\n"
                    "    sys.exit(17)\n"
                ),
            }.items():
                executable = root / name
                executable.write_text(script)
                executable.chmod(0o700)
            capture = root / "command.json"
            result = subprocess.run(
                ["bash", "evals/smoke.sh"],
                cwd=REPO,
                env={
                    **os.environ,
                    "PATH": f"{root}:{os.environ['PATH']}",
                    "REPO": str(REPO),
                    "CAPTURE": str(capture),
                    "JEV_EVAL_AUTH_MODE": "subscription",
                    "JEV_EVAL_CLAUDE_AUTH_DIR": str(auth),
                    "EVIDENCE_DIR": str(root / "evidence"),
                    "SMOKE_IMAGE": "test-image",
                    "TYPESAFE_API_KEY": "fake-jev",
                    "ANTHROPIC_API_KEY": "must-not-be-passed",
                },
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 17, result.stderr)
            command = json.loads(capture.read_text())
            self.assertNotIn("ANTHROPIC_API_KEY", command)
            self.assertNotIn("must-not-be-passed", " ".join(command))
            self.assertIn('"forceLoginMethod":"claudeai"', " ".join(command))
            shell = command[command.index("-ec") + 1]
            self.assertLess(shell.index("check_auth.cjs"), shell.index("exec claude"))
            self.assertIn("unset CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", shell)
            self.assertIn("ANTHROPIC_API_KEY", shell)
            self.assertNotIn("/logs/agent/.credentials.json", shell)


if __name__ == "__main__":
    unittest.main()
