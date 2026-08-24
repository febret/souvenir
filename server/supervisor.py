from __future__ import annotations

import logging
import subprocess
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Protocol

LOGGER = logging.getLogger(__name__)
RESTART_COMMAND = r"\r"


class ChildProcess(Protocol):
    def terminate(self) -> None: ...

    def wait(self) -> int: ...


def build_worker_command(
    *,
    python_executable: str,
    host: str,
    port: int,
    https: bool,
    cert_dir: Path | None,
) -> list[str]:
    command = [python_executable, "-m", "server", "--worker", "--host", host, "--port", str(port)]
    if https:
        command.append("--https")
    if cert_dir is not None:
        command.extend(["--cert-dir", str(cert_dir)])
    return command


def is_restart_command(command: str) -> bool:
    return command in {RESTART_COMMAND, "\r"}


def run_console_supervisor(
    command: list[str],
    *,
    stdin: Iterable[str],
    spawn: Callable[[list[str]], ChildProcess] = subprocess.Popen,
) -> int:
    """Run a finite console command stream, primarily useful for non-interactive callers."""
    child = spawn(command)
    try:
        for line in stdin:
            console_command = line.rstrip("\n")
            if is_restart_command(console_command):
                LOGGER.info("Restart requested; stopping current worker")
                child.terminate()
                child.wait()
                child = spawn(command)
            else:
                LOGGER.info(
                    "Unknown console command %r. Type %s then Enter to restart the worker.",
                    console_command.rstrip("\r"),
                    RESTART_COMMAND,
                )
        return child.wait()
    except KeyboardInterrupt:
        child.terminate()
        child.wait()
        raise
