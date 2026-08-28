from __future__ import annotations

import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Literal, Protocol

from PIL import Image, ImageOps

from .depth_maps import DepthMapStore

AutoDepthStatus = Literal["idle", "queued", "running", "completed", "failed", "cancelled"]
DEFAULT_AUTO_DEPTH_DIMENSION = 512
MAX_AUTO_DEPTH_DIMENSION = 2048


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fit_within_max_dimension(
    width: int,
    height: int,
    max_dimension: int = DEFAULT_AUTO_DEPTH_DIMENSION,
) -> tuple[int, int]:
    source_width = max(1, int(width))
    source_height = max(1, int(height))
    scale = min(1.0, max_dimension / max(source_width, source_height))
    return max(1, round(source_width * scale)), max(1, round(source_height * scale))


def _prepare_depth_input(
    image: Image.Image,
    *,
    max_dimension: int = DEFAULT_AUTO_DEPTH_DIMENSION,
) -> Image.Image:
    target_size = _fit_within_max_dimension(*image.size, max_dimension=max_dimension)
    if target_size == image.size:
        return image
    return image.resize(target_size, Image.Resampling.LANCZOS)


def _resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


class AutoDepthGenerator(Protocol):
    def generate(self, source: Path, *, max_dimension: int = DEFAULT_AUTO_DEPTH_DIMENSION) -> tuple[bytes, str]: ...

    def close(self) -> None: ...


class DepthAnythingAutoDepthGenerator:
    def __init__(
        self,
        *,
        model_id: str = "depth-anything/Depth-Anything-V2-Small-hf",
        device: Literal["auto", "cuda", "cpu"] = "auto",
    ) -> None:
        self.model_id = model_id
        self.device = _resolve_device(device)
        self._torch = None
        self._processor = None
        self._model = None

    def _load(self) -> None:
        if self._model is not None:
            return
        try:
            import torch
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation
        except ImportError as error:
            raise RuntimeError(
                "Auto-depth dependencies are missing. Install torch and transformers."
            ) from error
        self._torch = torch
        self._processor = AutoImageProcessor.from_pretrained(self.model_id)
        self._model = AutoModelForDepthEstimation.from_pretrained(self.model_id)
        self._model.eval()
        self._model.to(self.device)
        if self.device == "cuda":
            self._model.half()

    def generate(self, source: Path, *, max_dimension: int = DEFAULT_AUTO_DEPTH_DIMENSION) -> tuple[bytes, str]:
        self._load()
        with Image.open(source) as loaded:
            image = _prepare_depth_input(ImageOps.exif_transpose(loaded).convert("RGB"), max_dimension=max_dimension)
        inputs = self._processor(images=image, return_tensors="pt", do_resize=False)
        pixel_values = inputs["pixel_values"].to(self.device)
        if self.device == "cuda":
            pixel_values = pixel_values.half()
        with self._torch.inference_mode():
            outputs = self._model(pixel_values)
            depth = outputs.predicted_depth
            depth = self._torch.nn.functional.interpolate(
                depth.unsqueeze(1),
                size=image.size[::-1],
                mode="bilinear",
                align_corners=False,
            ).squeeze(1)
        min_value = depth.amin(dim=(1, 2), keepdim=True)
        max_value = depth.amax(dim=(1, 2), keepdim=True)
        normalized = (depth - min_value) / (max_value - min_value + 1e-8)
        frame = normalized[0].mul(255).clamp(0, 255).to(self._torch.uint8).cpu().numpy()
        depth_image = Image.fromarray(frame, mode="L")
        output = BytesIO()
        depth_image.save(output, format="PNG")
        return output.getvalue(), self.device

    def close(self) -> None:
        if self._model is not None:
            self._model.to("cpu")
            self._model = None
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()
        self._torch = None
        self._processor = None


@dataclass
class _JobState:
    request_id: int
    status: AutoDepthStatus
    requested_at: str
    updated_at: str
    started_at: str | None
    completed_at: str | None
    error: str | None
    device: str | None
    max_dimension: int
    cancel_requested: bool = False


class AutoDepthService:
    def __init__(
        self,
        root: Path,
        depth_maps: DepthMapStore,
        *,
        generator: AutoDepthGenerator | None = None,
    ) -> None:
        self._root = root
        self._depth_maps = depth_maps
        self._generator = generator or DepthAnythingAutoDepthGenerator()
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._queue: deque[str] = deque()
        self._jobs: dict[str, _JobState] = {}
        self._request_id = 0
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        with self._condition:
            if self._running:
                return
            self._running = True
            self._thread = threading.Thread(target=self._run, name="souvenir-auto-depth", daemon=True)
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
        self._generator.close()

    def request(self, relative: Path, *, max_dimension: int = DEFAULT_AUTO_DEPTH_DIMENSION) -> dict[str, object]:
        path = relative.as_posix()
        resolved_max_dimension = max(64, min(MAX_AUTO_DEPTH_DIMENSION, int(max_dimension)))
        with self._condition:
            existing = self._jobs.get(path)
            if existing and existing.status in {"queued", "running"}:
                return self._snapshot(relative, existing)
            self._request_id += 1
            now = _timestamp()
            state = _JobState(
                request_id=self._request_id,
                status="queued",
                requested_at=now,
                updated_at=now,
                started_at=None,
                completed_at=None,
                error=None,
                device=None,
                max_dimension=resolved_max_dimension,
            )
            self._jobs[path] = state
            self._queue.append(path)
            self._condition.notify_all()
            return self._snapshot(relative, state)

    def status(self, relative: Path) -> dict[str, object]:
        with self._lock:
            state = self._jobs.get(relative.as_posix())
            if state is None:
                return self._snapshot(relative, None)
            return self._snapshot(relative, state)

    def cancel(self, relative: Path) -> dict[str, object]:
        path = relative.as_posix()
        with self._condition:
            state = self._jobs.get(path)
            if state is None:
                return self._snapshot(relative, None)
            if state.status == "queued":
                now = _timestamp()
                state.status = "cancelled"
                state.cancel_requested = True
                state.updated_at = now
                state.completed_at = now
            elif state.status == "running":
                state.cancel_requested = True
                state.updated_at = _timestamp()
            return self._snapshot(relative, state)

    def _run(self) -> None:
        while True:
            with self._condition:
                while self._running and not self._queue:
                    self._condition.wait(timeout=0.5)
                if not self._running:
                    return
                path = self._queue.popleft()
                state = self._jobs.get(path)
                if state is None or state.status != "queued":
                    continue
                if state.cancel_requested:
                    now = _timestamp()
                    state.status = "cancelled"
                    state.updated_at = now
                    state.completed_at = now
                    continue
                state.status = "running"
                state.started_at = _timestamp()
                state.updated_at = state.started_at
                request_id = state.request_id
                max_dimension = state.max_dimension
            self._process(path, request_id, max_dimension)

    def _process(self, path: str, request_id: int, max_dimension: int) -> None:
        relative = Path(path)
        try:
            data, device = self._generator.generate(
                self._root / relative,
                max_dimension=max_dimension,
            )
            with self._condition:
                state = self._jobs.get(path)
                if state is None or state.request_id != request_id:
                    return
                if state.cancel_requested:
                    now = _timestamp()
                    state.status = "cancelled"
                    state.updated_at = now
                    state.completed_at = now
                    state.device = device
                    return
            self._depth_maps.write(relative, data)
            with self._condition:
                state = self._jobs.get(path)
                if state is None or state.request_id != request_id:
                    return
                now = _timestamp()
                state.status = "completed"
                state.updated_at = now
                state.completed_at = now
                state.device = device
                state.error = None
        except Exception as error:
            with self._condition:
                state = self._jobs.get(path)
                if state is None or state.request_id != request_id:
                    return
                now = _timestamp()
                state.status = "failed"
                state.updated_at = now
                state.completed_at = now
                state.error = str(error)

    def _snapshot(self, relative: Path, state: _JobState | None) -> dict[str, object]:
        depth_info = self._depth_maps.info(relative)
        if state is None:
            return {
                "path": relative.as_posix(),
                "status": "idle",
                "requested_at": None,
                "started_at": None,
                "completed_at": None,
                "updated_at": None,
                "error": None,
                "device": None,
                "max_dimension": None,
                "depth": depth_info,
            }
        return {
            "path": relative.as_posix(),
            "status": state.status,
            "requested_at": state.requested_at,
            "started_at": state.started_at,
            "completed_at": state.completed_at,
            "updated_at": state.updated_at,
            "error": state.error,
            "device": state.device,
            "max_dimension": state.max_dimension,
            "depth": depth_info,
        }
