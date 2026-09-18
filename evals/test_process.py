import os
import subprocess
import sys
import unittest
from unittest.mock import patch

from evals.process import AdoptedProcess, process_fields


@unittest.skipUnless(sys.platform == "linux", "Linux process handoff")
class ProcessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.command = [sys.executable, "-c", "import time; time.sleep(60)"]
        self.child = subprocess.Popen(self.command, start_new_session=True)
        self.addCleanup(self.cleanup)

    def cleanup(self) -> None:
        if self.child.poll() is None:
            self.child.terminate()
        self.child.wait(timeout=5)

    def test_tracks_lifetime_without_inventing_an_exit_code(self) -> None:
        process = AdoptedProcess(self.child.pid, os.getpid(), self.command)
        self.assertIsNone(process.poll())
        with self.assertRaises(subprocess.TimeoutExpired):
            process.wait(timeout=0)
        self.child.terminate()
        process.wait(timeout=5)
        self.assertIsNone(process.returncode)

    def test_rejects_wrong_parent_and_command(self) -> None:
        with self.assertRaisesRegex(ValueError, "isolated child"):
            AdoptedProcess(self.child.pid, -1, self.command)
        with self.assertRaisesRegex(ValueError, "command"):
            AdoptedProcess(self.child.pid, os.getpid(), ["unrelated"])

    def test_does_not_follow_a_reused_pid(self) -> None:
        process = AdoptedProcess(self.child.pid, os.getpid(), self.command)
        fields = process_fields(self.child.pid)
        fields[19] = str(int(fields[19]) + 1)
        with patch("evals.process.process_fields", return_value=fields):
            self.assertEqual(process.poll(), 0)
        self.assertIsNone(self.child.poll())
