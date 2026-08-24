from __future__ import annotations

import argparse
import os
from pathlib import Path
import queue
import signal
import subprocess
import sys
import threading
from typing import TextIO

import uvicorn

from .application import create_app
from .certificates import ensure_certificates
from .config import MEDIA_HOME_ENV, PORT_ENV, Settings, load_settings
from .library import configure_console_logging
from .supervisor import RESTART_COMMAND, build_worker_command, is_restart_command

SHUTDOWN_TIMEOUT_SECONDS = 5
COMMAND_POLL_SECONDS = 0.25


def _parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Serve a Souvenir media library",
        epilog=r"At the supervisor console, type \r then Enter to restart the worker.",
    )
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--https", action="store_true", help="serve directly with a reusable local certificate")
    parser.add_argument("--cert-dir", type=Path, default=None)
    parser.add_argument("--worker", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def _log(message: str) -> None:
    print(f"Souvenir supervisor: {message}", flush=True)


def _run_worker(args: argparse.Namespace, settings: Settings) -> None:
    kwargs = {}
    if args.https:
        certificates = ensure_certificates(args.cert_dir or settings.media_home / ".souvenir-certs")
        kwargs = {"ssl_certfile": str(certificates.server_certificate), "ssl_keyfile": str(certificates.server_key)}
    config = uvicorn.Config(
        create_app(settings.media_home),
        host=args.host,
        port=args.port or settings.port,
        **kwargs,
    )
    configure_console_logging()
    server = uvicorn.Server(config)
    try:
        server.run()
    except KeyboardInterrupt:
        server.should_exit = True


def _spawn_worker(args: argparse.Namespace, settings: Settings, port: int) -> subprocess.Popen[bytes]:
    environment = os.environ.copy()
    environment[MEDIA_HOME_ENV] = str(settings.media_home)
    environment[PORT_ENV] = str(port)
    popen_args: dict[str, object] = {
        "env": environment,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        popen_args["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    command = build_worker_command(
        python_executable=sys.executable,
        host=args.host,
        port=port,
        https=args.https,
        cert_dir=args.cert_dir,
    )
    return subprocess.Popen(command, **popen_args)


def _read_console_commands(commands: queue.Queue[str | None], stdin: TextIO) -> None:
    while True:
        line = stdin.readline()
        if line == "":
            commands.put(None)
            return
        commands.put(line.rstrip("\r\n"))


def _stop_worker(worker: subprocess.Popen[bytes]) -> None:
    if worker.poll() is not None:
        return
    if os.name == "nt":
        _log("requesting graceful worker shutdown")
        try:
            worker.send_signal(signal.CTRL_BREAK_EVENT)
        except OSError as error:
            _log(f"could not send worker shutdown signal ({error}); terminating worker")
            worker.terminate()
    else:
        _log("requesting graceful worker shutdown")
        worker.terminate()
    try:
        worker.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)
        return
    except subprocess.TimeoutExpired:
        _log("worker did not stop in time; forcing termination")
    worker.kill()
    worker.wait(timeout=SHUTDOWN_TIMEOUT_SECONDS)


def _run_supervisor(args: argparse.Namespace, settings: Settings) -> int:
    port = args.port or settings.port
    commands: queue.Queue[str | None] = queue.Queue()
    threading.Thread(
        target=_read_console_commands,
        args=(commands, sys.stdin),
        name="souvenir-console",
        daemon=True,
    ).start()
    _log(f"started on {args.host}:{port}. Type {RESTART_COMMAND} then Enter to restart the server.")
    _log(f"Console help: {RESTART_COMMAND} restarts the worker; other commands show this help.")
    worker = _spawn_worker(args, settings, port)
    console_open = True
    try:
        while True:
            return_code = worker.poll()
            if return_code is not None:
                _log(f"worker exited unexpectedly with status {return_code}; supervisor is stopping")
                return return_code or 1
            try:
                command = commands.get(timeout=COMMAND_POLL_SECONDS)
            except queue.Empty:
                continue
            if command is None:
                if console_open:
                    _log("console input is unavailable; worker will continue running")
                    console_open = False
                continue
            if not is_restart_command(command):
                _log(f"unknown command {command!r}. Type {RESTART_COMMAND} then Enter to restart the worker.")
                continue
            _log("restart requested; stopping current worker")
            _stop_worker(worker)
            _log("starting fresh worker")
            worker = _spawn_worker(args, settings, port)
    except KeyboardInterrupt:
        _log("KeyboardInterrupt received; shutting down worker")
        _stop_worker(worker)
        return 0


def main() -> None:
    args = _parse_arguments()
    settings = load_settings()
    if args.worker:
        _run_worker(args, settings)
        return
    raise SystemExit(_run_supervisor(args, settings))


if __name__ == "__main__":
    main()
