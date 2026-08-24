from __future__ import annotations

import logging
from pathlib import Path

import pytest

from server.supervisor import build_worker_command, run_console_supervisor


class FakeChild:
    def __init__(self, return_code: int = 0) -> None:
        self.return_code = return_code
        self.terminate_calls = 0
        self.wait_calls = 0

    def terminate(self) -> None:
        self.terminate_calls += 1

    def wait(self) -> int:
        self.wait_calls += 1
        return self.return_code


class SpawnRecorder:
    def __init__(self, children: list[FakeChild]) -> None:
        self.children = iter(children)
        self.commands: list[list[str]] = []

    def __call__(self, command: list[str]) -> FakeChild:
        self.commands.append(command)
        return next(self.children)


class EofInput:
    def __init__(self) -> None:
        self.next_calls = 0

    def __iter__(self) -> EofInput:
        return self

    def __next__(self) -> str:
        self.next_calls += 1
        raise StopIteration


class InterruptingInput:
    def __iter__(self) -> InterruptingInput:
        return self

    def __next__(self) -> str:
        raise KeyboardInterrupt


def test_carriage_return_restarts_old_child_once_and_waits_for_replacement():
    old_child = FakeChild()
    replacement = FakeChild(return_code=17)
    spawn = SpawnRecorder([old_child, replacement])
    command = ["python", "-m", "server", "--worker"]

    result = run_console_supervisor(command, stdin=iter(["\r"]), spawn=spawn)

    assert result == 17
    assert spawn.commands == [command, command]
    assert old_child.terminate_calls == old_child.wait_calls == 1
    assert replacement.terminate_calls == 0
    assert replacement.wait_calls == 1


def test_unknown_console_command_logs_message_without_restarting(caplog):
    child = FakeChild()
    spawn = SpawnRecorder([child])
    caplog.set_level(logging.INFO, logger="server.supervisor")

    run_console_supervisor(["python", "-m", "server", "--worker"], stdin=iter(["reload\n"]), spawn=spawn)

    assert len(spawn.commands) == 1
    assert child.terminate_calls == 0
    assert any(
        "Unknown console command" in record.getMessage() and "reload" in record.getMessage()
        for record in caplog.records
    )


def test_stdin_eof_waits_for_healthy_child_without_terminating_or_looping():
    child = FakeChild(return_code=23)
    spawn = SpawnRecorder([child])
    stdin = EofInput()

    result = run_console_supervisor(["python", "-m", "server", "--worker"], stdin=stdin, spawn=spawn)

    assert result == 23
    assert stdin.next_calls == 1
    assert len(spawn.commands) == 1
    assert child.terminate_calls == 0
    assert child.wait_calls == 1


def test_keyboard_interrupt_terminates_and_waits_for_child():
    child = FakeChild()
    spawn = SpawnRecorder([child])

    with pytest.raises(KeyboardInterrupt):
        run_console_supervisor(
            ["python", "-m", "server", "--worker"],
            stdin=InterruptingInput(),
            spawn=spawn,
        )

    assert child.terminate_calls == child.wait_calls == 1


def test_worker_command_preserves_server_options():
    command = build_worker_command(
        python_executable=r"C:\Python\python.exe",
        host="127.0.0.1",
        port=9123,
        https=True,
        cert_dir=Path(r"C:\certificates"),
    )

    assert command == [
        r"C:\Python\python.exe",
        "-m",
        "server",
        "--worker",
        "--host",
        "127.0.0.1",
        "--port",
        "9123",
        "--https",
        "--cert-dir",
        r"C:\certificates",
    ]
