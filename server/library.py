from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path
from time import monotonic

from .media import INTERNAL_DIRECTORIES, INTERNAL_FILES, media_type

LOGGER = logging.getLogger(__name__)

LibraryScanner = Callable[[Path, "LibraryScanProgress"], None]


def configure_console_logging() -> None:
    """Route library INFO records through uvicorn's configured console handlers."""
    uvicorn_logger = logging.getLogger("uvicorn")
    if not uvicorn_logger.handlers:
        return
    LOGGER.handlers = list(uvicorn_logger.handlers)
    LOGGER.setLevel(logging.INFO)
    LOGGER.propagate = False


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class LibraryScanProgress:
    """Thread-safe state exposed while the media library is being scanned."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._status = "scanning"
        self._scanned_files = 0
        self._media_files = 0
        self._directories = 0
        self._current_path = ""
        self._message = "Waiting for library scan to start"
        self._started_at: str | None = None
        self._completed_at: str | None = None
        self._unreadable_entries = 0

    def begin(self) -> None:
        with self._lock:
            self._status = "scanning"
            self._scanned_files = 0
            self._media_files = 0
            self._directories = 0
            self._current_path = ""
            self._message = "Scanning media library"
            self._started_at = _timestamp()
            self._completed_at = None
            self._unreadable_entries = 0

    def set_current_path(self, path: str) -> None:
        with self._lock:
            self._current_path = path

    def record_directory(self, path: str) -> None:
        with self._lock:
            self._directories += 1
            self._current_path = path

    def record_file(self, path: str, *, is_media_file: bool) -> None:
        with self._lock:
            self._scanned_files += 1
            if is_media_file:
                self._media_files += 1
            self._current_path = path

    def record_unreadable(self, path: str) -> None:
        with self._lock:
            self._unreadable_entries += 1
            self._current_path = path

    def finish(self) -> None:
        with self._lock:
            self._status = "ready"
            self._completed_at = _timestamp()
            if self._unreadable_entries:
                self._message = f"Scan complete; skipped {self._unreadable_entries} unreadable entries"
            else:
                self._message = "Scan complete"

    def fail(self, error: Exception) -> None:
        with self._lock:
            self._status = "error"
            self._message = f"Library scan failed: {error}"
            self._completed_at = _timestamp()

    def snapshot(self) -> dict[str, str | int | None]:
        with self._lock:
            return {
                "status": self._status,
                "scanned_files": self._scanned_files,
                "media_files": self._media_files,
                "directories": self._directories,
                "current_path": self._current_path,
                "message": self._message,
                "started_at": self._started_at,
                "completed_at": self._completed_at,
            }


def _relative_path(root: Path, path: Path) -> str:
    relative = path.relative_to(root)
    return "" if relative == Path() else relative.as_posix()


def _is_safe_entry(root: Path, entry: os.DirEntry[str]) -> bool:
    try:
        Path(entry.path).resolve(strict=True).relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return False
    return True


def scan_media_library(
    root: Path,
    progress: LibraryScanProgress,
    *,
    log_every_files: int = 250,
    logger: logging.Logger = LOGGER,
) -> None:
    """Traverse media_root without following symlinks and update scan progress."""
    if log_every_files < 1:
        raise ValueError("log_every_files must be at least 1")

    pending = [root]
    processed_files = 0
    while pending:
        directory = pending.pop()
        progress.set_current_path(_relative_path(root, directory))
        try:
            with os.scandir(directory) as entries:
                for entry in entries:
                    path = Path(entry.path)
                    relative = _relative_path(root, path)
                    try:
                        if entry.is_symlink():
                            logger.warning("Skipping symbolic link during library scan: %s", path)
                            continue
                        if not _is_safe_entry(root, entry):
                            logger.warning("Skipping entry outside media root during library scan: %s", path)
                            continue
                        if entry.is_dir(follow_symlinks=False):
                            if entry.name in INTERNAL_DIRECTORIES:
                                continue
                            progress.record_directory(relative)
                            pending.append(path)
                            continue
                        if entry.is_file(follow_symlinks=False):
                            if entry.name in INTERNAL_FILES:
                                continue
                            progress.record_file(relative, is_media_file=media_type(path) is not None)
                            processed_files += 1
                            if processed_files % log_every_files == 0:
                                snapshot = progress.snapshot()
                                logger.info(
                                    "Media library scan progress: %d files, %d media files, %d directories",
                                    snapshot["scanned_files"],
                                    snapshot["media_files"],
                                    snapshot["directories"],
                                )
                    except OSError as error:
                        progress.record_unreadable(relative)
                        logger.warning("Unable to inspect library entry %s: %s", path, error)
        except OSError as error:
            progress.record_unreadable(_relative_path(root, directory))
            logger.warning("Unable to read library directory %s: %s", directory, error)


class LibraryScanService:
    def __init__(
        self,
        root: Path,
        scanner: LibraryScanner = scan_media_library,
        *,
        logger: logging.Logger = LOGGER,
    ) -> None:
        self.progress = LibraryScanProgress()
        self._root = root
        self._scanner = scanner
        self._logger = logger
        self._thread: threading.Thread | None = None
        self._start_lock = threading.Lock()

    def start(self) -> None:
        with self._start_lock:
            if self._thread is not None:
                return
            self._thread = threading.Thread(target=self._run, name="souvenir-library-scan", daemon=True)
            self._thread.start()

    def wait(self, timeout: float | None = None) -> bool:
        thread = self._thread
        if thread is None:
            return False
        thread.join(timeout)
        return not thread.is_alive()

    def _run(self) -> None:
        started = monotonic()
        self.progress.begin()
        self._logger.info("Starting media library scan: %s", self._root)
        try:
            self._scanner(self._root, self.progress)
        except Exception as error:
            self.progress.fail(error)
            self._logger.exception("Media library scan failed: %s", error)
            return
        self.progress.finish()
        snapshot = self.progress.snapshot()
        self._logger.info(
            "Media library scan complete in %.2fs: %d files, %d media files, %d directories",
            monotonic() - started,
            snapshot["scanned_files"],
            snapshot["media_files"],
            snapshot["directories"],
        )
