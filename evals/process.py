"""Attach a replacement coordinator to its predecessor's Linux child process."""

import subprocess
import time
from pathlib import Path


def process_fields(pid: int) -> list[str]:
    return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()


class AdoptedProcess:
    def __init__(self, pid: int, parent: int, command: list[str]) -> None:
        fields = process_fields(pid)
        actual = (
            Path(f"/proc/{pid}/cmdline").read_bytes().decode().rstrip("\0").split("\0")
        )
        if int(fields[1]) != parent or int(fields[2]) != pid:
            raise ValueError("Process is not an isolated child of the old launcher")
        if actual != command and actual[1:] != command:
            raise ValueError("Process command does not match the declared trial")
        self.pid = pid
        self.returncode: int | None = None
        self.start_time = fields[19]

    def poll(self) -> int | None:
        try:
            fields = process_fields(self.pid)
        except FileNotFoundError:
            return 0
        if fields[19] != self.start_time or fields[0] == "Z":
            return 0
        return None

    def wait(self, timeout: float | None = None) -> int:
        started = time.monotonic()
        while self.poll() is None:
            if timeout is not None and time.monotonic() - started >= timeout:
                raise subprocess.TimeoutExpired(f"Harbor PID {self.pid}", timeout)
            time.sleep(0.1)
        return 0
