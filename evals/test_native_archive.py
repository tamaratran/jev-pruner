import tempfile
import unittest
from pathlib import Path

from evals.summarize import native_archive_exists


class NativeArchiveTests(unittest.TestCase):
    def test_only_existing_downloaded_originals_are_recognized(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            agent = Path(directory) / "agent"
            original = agent / "sessions/projects/project/session/tool-results/out.txt"
            original.parent.mkdir(parents=True)
            original.write_text("original output")
            for prefix in (
                "/opt/jev-eval/auth/projects",
                "/logs/agent/sessions/projects",
            ):
                with self.subTest(prefix=prefix):
                    self.assertTrue(
                        native_archive_exists(
                            agent,
                            f"[fast-jev-output full output: {prefix}/project/session/"
                            "tool-results/out.txt (Read or grep it if needed)]",
                        )
                    )
            original.unlink()
            self.assertFalse(
                native_archive_exists(
                    agent,
                    "[fast-jev-output full output: /opt/jev-eval/auth/projects/"
                    "project/session/tool-results/out.txt (Read or grep it if needed)]",
                )
            )

    def test_private_paths_traversal_and_symlinks_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            agent = root / "agent"
            original = agent / "sessions/projects/project/session/tool-results/out.txt"
            original.parent.mkdir(parents=True)
            private = root / "private.txt"
            private.write_text("private fixture")
            original.symlink_to(private)
            for path in (
                str(private),
                "/opt/jev-eval/auth/.credentials.json",
                "/opt/jev-eval/login/.credentials.json",
                "/opt/jev-eval/auth/projects/project/session/tool-results/out.txt",
                "/opt/jev-eval/auth/projects/../../../private.txt",
            ):
                with self.subTest(path=path):
                    self.assertFalse(
                        native_archive_exists(
                            agent,
                            f"[fast-jev-output full output: {path}"
                            " (Read or grep it if needed)]",
                        )
                    )
