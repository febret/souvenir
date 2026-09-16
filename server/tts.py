from __future__ import annotations

import asyncio
import importlib.util
import os
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from fastapi import HTTPException

from .media import TTS_WORK_DIRNAME
MAX_TTS_TEXT_LENGTH = 2000
TTS_TUNING_MIN = -50
TTS_TUNING_MAX = 50
MAX_TTS_PENDING = 24
MAX_TTS_SAVED_JOBS = 32
TTS_VOICES_TTL_SECONDS = 6 * 60 * 60
_EDGE_TTS_DEPENDENCIES = ("aiohttp", "edge_tts")

TtsStatus = str


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


class TtsGenerator(Protocol):
    def synthesize(
        self,
        output: Path,
        *,
        text: str,
        voice: str,
        rate_percent: int,
        pitch_percent: int,
    ) -> str: ...

    def list_voices(self) -> list[dict[str, str]]: ...


def _missing_runtime_dependencies(packages: tuple[str, ...]) -> list[str]:
    missing: list[str] = []
    for package in packages:
        if importlib.util.find_spec(package) is None:
            missing.append(package)
    return missing


def _voice_entry(raw: dict[str, object]) -> dict[str, str]:
    """Extract the client-facing voice shape from an edge-tts catalog entry."""
    if not isinstance(raw, dict):
        return {"id": "", "name": "", "locale": "", "gender": ""}
    short_name = str(raw.get("ShortName") or "")
    return {
        "id": short_name,
        "name": str(raw.get("FriendlyName") or short_name),
        "locale": str(raw.get("Locale") or ""),
        "gender": str(raw.get("Gender") or ""),
    }


class EdgeTtsGenerator:
    """Synthesize commentary previews through Microsoft Edge's online TTS."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._voices_cache: list[dict[str, str]] | None = None
        self._voices_cached_at = 0.0

    @staticmethod
    def _module():
        try:
            import edge_tts
        except ImportError as error:
            missing = _missing_runtime_dependencies(_EDGE_TTS_DEPENDENCIES)
            quoted = ", ".join(sorted(missing))
            raise RuntimeError(
                "Commentary TTS dependencies are missing "
                f"({quoted}). Install requirements with "
                "`python -m pip install -r requirements.txt`."
            ) from error
        return edge_tts

    def synthesize(
        self,
        output: Path,
        *,
        text: str,
        voice: str,
        rate_percent: int,
        pitch_percent: int,
    ) -> str:
        edge_tts = self._module()
        communicate = edge_tts.Communicate(
            text,
            voice,
            rate=f"{rate_percent:+d}%",
            pitch=f"{pitch_percent:+d}Hz",
        )
        communicate.save_sync(str(output))
        return "audio/mpeg"

    def list_voices(self) -> list[dict[str, str]]:
        now = time.monotonic()
        with self._lock:
            if (
                self._voices_cache is not None
                and now - self._voices_cached_at < TTS_VOICES_TTL_SECONDS
            ):
                return [dict(voice) for voice in self._voices_cache]
            cached_at = self._voices_cached_at
        edge_tts = self._module()
        try:
            raw_voices = asyncio.run(asyncio.wait_for(edge_tts.list_voices(), timeout=10))
        except (OSError, RuntimeError, ValueError, TimeoutError, asyncio.TimeoutError) as error:
            raise RuntimeError("The TTS voice catalog could not be reached.") from error
        voices = [voice for voice in (_voice_entry(raw) for raw in raw_voices or []) if voice["id"]]
        with self._lock:
            # Concurrent callers may fetch simultaneously; only the first
            # writer refreshes the cache so a newer entry is never clobbered.
            if self._voices_cached_at == cached_at:
                self._voices_cache = voices
                self._voices_cached_at = time.monotonic()
        return [dict(voice) for voice in voices]


@dataclass
class _JobState:
    request_id: str
    status: TtsStatus
    text: str
    voice: str
    rate_percent: int
    pitch_percent: int
    requested_at: str
    updated_at: str
    started_at: str | None
    completed_at: str | None
    error: str | None
    file_name: str | None
    media_type: str | None


class CommentaryTtsService:
    """Queued commentary preview synthesis with edge-tts."""

    def __init__(
        self,
        work_root: Path,
        *,
        generator: TtsGenerator | None = None,
    ) -> None:
        self._work_root = work_root
        self._generator = generator or EdgeTtsGenerator()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._queue: deque[str] = deque()
        self._jobs: dict[str, _JobState] = {}
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._condition:
            if self._running:
                return
            try:
                self._work_root.mkdir(parents=True, exist_ok=True)
            except OSError as error:
                raise RuntimeError(
                    f"TTS preview directory is unavailable: {self._work_root}"
                ) from error
            if not self._work_root.is_dir():
                raise RuntimeError(f"TTS preview directory is unavailable: {self._work_root}")
            self._clear_preview_files()
            self._running = True
            self._thread = threading.Thread(target=self._run, name="souvenir-tts", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        thread: threading.Thread | None
        with self._condition:
            self._running = False
            self._condition.notify_all()
            thread = self._thread
            self._thread = None
        if thread is not None:
            thread.join(timeout=5)
        self._clear_preview_files()

    def request(
        self,
        text: str,
        voice: str,
        rate_percent: int,
        pitch_percent: int,
    ) -> dict[str, object]:
        with self._condition:
            pending = sum(
                1 for state in self._jobs.values()
                if state.status in {"queued", "running"}
            )
            if pending >= MAX_TTS_PENDING:
                raise HTTPException(429, "TTS queue is full; wait for a preview to finish")
            request_id = uuid.uuid4().hex
            now = _timestamp()
            state = _JobState(
                request_id=request_id,
                status="queued",
                text=text,
                voice=voice,
                rate_percent=rate_percent,
                pitch_percent=pitch_percent,
                requested_at=now,
                updated_at=now,
                started_at=None,
                completed_at=None,
                error=None,
                file_name=None,
                media_type=None,
            )
            self._jobs[request_id] = state
            self._queue.append(request_id)
            self._condition.notify_all()
            self._prune(request_id)
            return self._snapshot(state)

    def status(self, request_id: str) -> dict[str, object] | None:
        with self._lock:
            state = self._jobs.get(request_id)
            if state is None:
                return None
            return self._snapshot(state)

    def cancel(self, request_id: str) -> dict[str, object]:
        with self._condition:
            state = self._jobs.get(request_id)
            if state is None:
                raise HTTPException(404, "TTS request was not found")
            if state.status not in {"queued", "running"}:
                return self._snapshot(state)
            now = _timestamp()
            state.status = "cancelled"
            state.updated_at = now
            state.completed_at = now
            self._condition.notify_all()
            self._remove_file(state)
            return self._snapshot(state)

    def file(self, request_id: str) -> tuple[Path, str] | None:
        with self._lock:
            state = self._jobs.get(request_id)
            if state is None or state.status != "completed" or not state.file_name:
                return None
            candidate = self._work_root / state.file_name
            try:
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(self._work_root.resolve())
            except (OSError, RuntimeError, ValueError):
                return None
            if not resolved.is_file():
                return None
            return resolved, state.media_type or "audio/mpeg"

    def list_voices(self) -> list[dict[str, str]]:
        return self._generator.list_voices()

    def _run(self) -> None:
        while True:
            with self._condition:
                while self._running and not self._queue:
                    self._condition.wait(timeout=0.5)
                if not self._running:
                    return
                request_id = self._queue.popleft()
                state = self._jobs.get(request_id)
                if state is None or state.status != "queued":
                    continue
                state.status = "running"
                state.started_at = _timestamp()
                state.updated_at = state.started_at
            self._process(state)

    def _process(self, state: _JobState) -> None:
        request_id = state.request_id
        output = self._work_root / f"{request_id}.mp3"
        try:
            media_type = self._generator.synthesize(
                output,
                text=state.text,
                voice=state.voice,
                rate_percent=state.rate_percent,
                pitch_percent=state.pitch_percent,
            )
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("TTS produced no audio")
            with self._condition:
                # Double-check that job still exists and is running
                current = self._jobs.get(request_id)
                if current is None or current.status != "running":
                    # Job was cancelled or changed status, clean up file if needed
                    try:
                        output.unlink(missing_ok=True)
                    except OSError:
                        pass
                    return
                now = _timestamp()
                current.status = "completed"
                current.updated_at = now
                current.completed_at = now
                current.error = None
                current.file_name = output.name
                current.media_type = media_type
                self._prune(request_id)
        except Exception as error:
            try:
                output.unlink(missing_ok=True)
            except OSError:
                pass
            with self._condition:
                # Double-check that job still exists and is running before updating
                current = self._jobs.get(request_id)
                if current is None or current.status != "running":
                    return
                now = _timestamp()
                current.status = "failed"
                current.updated_at = now
                current.completed_at = now
                current.error = str(error)
                self._prune(request_id)

    def _snapshot(self, state: _JobState) -> dict[str, object]:
        return {
            "id": state.request_id,
            "status": state.status,
            "text": state.text,
            "voice": state.voice,
            "rate": state.rate_percent,
            "pitch": state.pitch_percent,
            "requested_at": state.requested_at,
            "started_at": state.started_at,
            "completed_at": state.completed_at,
            "updated_at": state.updated_at,
            "error": state.error,
            "media_type": state.media_type,
            "url": (
                f"/api/commentary/tts/file?request_id={state.request_id}"
                if state.status == "completed" and state.file_name
                else None
            ),
        }

    def _prune(self, request_id: str) -> None:
        active = [
            state.request_id
            for state in self._jobs.values()
            if state.status in {"queued", "running"}
        ]
        terminal = [
            state.request_id
            for state in self._jobs.values()
            if state.status in {"completed", "failed", "cancelled"}
        ]
        keep = set(active) | set(terminal[-MAX_TTS_SAVED_JOBS:]) | {request_id}
        for cached_id, state in list(self._jobs.items()):
            if cached_id not in keep:
                self._remove_file(state)
                del self._jobs[cached_id]

    def _remove_file(self, state: _JobState) -> None:
        if not state.file_name:
            return
        try:
            candidate = self._work_root / state.file_name
            if candidate.is_symlink():
                return
            candidate.unlink(missing_ok=True)
        except OSError:
            pass
        state.file_name = None
        state.media_type = None

    def _clear_preview_files(self) -> None:
        try:
            with os.scandir(self._work_root) as children:
                for child in children:
                    try:
                        if not child.is_symlink() and child.is_file():
                            Path(child.path).unlink(missing_ok=True)
                    except OSError:
                        continue
        except OSError:
            return


def normalize_tts_text(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "text must be a string")
    text = value.strip()
    if not text:
        raise HTTPException(422, "text must not be empty")
    if len(text) > MAX_TTS_TEXT_LENGTH:
        raise HTTPException(
            422,
            f"text must be no more than {MAX_TTS_TEXT_LENGTH} characters",
        )
    return text


def normalize_tts_tuning(value: object, *, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(422, f"{name} must be an integer")
    if not TTS_TUNING_MIN <= value <= TTS_TUNING_MAX:
        raise HTTPException(
            422,
            f"{name} must be between {TTS_TUNING_MIN} and {TTS_TUNING_MAX}",
        )
    return value


def validate_tts_voice(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "voice must be a string")
    voice = value.strip()
    if not voice:
        raise HTTPException(422, "voice must not be empty")
    return voice


_REQUEST_ID = re.compile(r"[0-9a-f]{32}")


def require_request_id(value: str) -> str:
    if not isinstance(value, str) or _REQUEST_ID.fullmatch(value) is None:
        raise HTTPException(404, "TTS request was not found")
    return value