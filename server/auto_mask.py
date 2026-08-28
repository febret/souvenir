from __future__ import annotations

import importlib.util
import threading
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Literal, Protocol

from PIL import Image, ImageOps

from .masks import MaskStore

AutoMaskStatus = Literal["idle", "queued", "running", "completed", "failed", "cancelled"]
DEFAULT_AUTO_MASK_DIMENSION = 512
MAX_AUTO_MASK_DIMENSION = 2048
AUTO_MASK_INFERENCE_MAX_DIMENSION = DEFAULT_AUTO_MASK_DIMENSION
AUTO_MASK_DEFAULT_BLUR = 32
BIREFNET_RUNTIME_DEPENDENCIES = (
    "torch",
    "torchvision",
    "transformers",
    "einops",
    "kornia",
    "timm",
)


def _timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _fit_within_max_dimension(
    width: int,
    height: int,
    max_dimension: int = AUTO_MASK_INFERENCE_MAX_DIMENSION,
    divisible_by: int = 32,
) -> tuple[int, int]:
    source_width = max(1, int(width))
    source_height = max(1, int(height))
    scale = min(1.0, max_dimension / max(source_width, source_height))
    target_width = source_width * scale
    target_height = source_height * scale
    rounded_width = (int(target_width) // divisible_by) * divisible_by
    rounded_height = (int(target_height) // divisible_by) * divisible_by
    if rounded_width < divisible_by and rounded_height < divisible_by:
        return divisible_by, divisible_by
    return max(divisible_by, rounded_width), max(divisible_by, rounded_height)


def _inference_image(image: Image.Image, max_dimension: int) -> Image.Image:
    target_size = _fit_within_max_dimension(*image.size, max_dimension=max_dimension)
    if target_size == image.size:
        return image
    return image.resize(target_size, Image.Resampling.LANCZOS)


def _background_mask(
    probability: Image.Image,
    output_size: tuple[int, int],
    *,
    threshold: float,
) -> Image.Image:
    threshold_value = round(threshold * 255)
    foreground = probability.convert("L").point(
        lambda value: 255 if value >= threshold_value else 0,
        mode="L",
    )
    background = ImageOps.invert(foreground)
    if background.size != output_size:
        background = background.resize(output_size, Image.Resampling.NEAREST)
    return background


def _resolve_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _missing_runtime_dependencies(packages: tuple[str, ...]) -> list[str]:
    missing: list[str] = []
    for package in packages:
        if importlib.util.find_spec(package) is None:
            missing.append(package)
    return missing


class AutoMaskGenerator(Protocol):
    def generate(self, source: Path, *, max_dimension: int | None = None) -> tuple[bytes, str]: ...

    def close(self) -> None: ...


class BiRefNetAutoMaskGenerator:
    def __init__(
        self,
        *,
        model_id: str = "ZhengPeng7/BiRefNet",
        device: Literal["auto", "cuda", "cpu"] = "auto",
        input_size: int = DEFAULT_AUTO_MASK_DIMENSION,
        threshold: float = 0.48,
    ) -> None:
        self.model_id = model_id
        self.device = _resolve_device(device)
        self.input_size = min(MAX_AUTO_MASK_DIMENSION, max(1, int(input_size)))
        self.threshold = threshold
        self._model = None
        self._torch = None
        self._transforms = None

    def _load(self) -> None:
        if self._model is not None:
            return
        missing = _missing_runtime_dependencies(BIREFNET_RUNTIME_DEPENDENCIES)
        if missing:
            quoted = ", ".join(sorted(missing))
            raise RuntimeError(
                "Auto-mask dependencies are missing "
                f"({quoted}). Install requirements with "
                "`python -m pip install -r requirements.txt`."
            )
        try:
            import torch
            from torchvision.transforms import v2
            from transformers import AutoModelForImageSegmentation
        except ImportError as error:
            raise RuntimeError(
                "Auto-mask dependencies are missing. Install torch, torchvision, and transformers."
            ) from error
        try:
            model = AutoModelForImageSegmentation.from_pretrained(
                self.model_id,
                trust_remote_code=True,
            )
        except ModuleNotFoundError as error:
            missing_module = (error.name or "").split(".")[0]
            if missing_module in BIREFNET_RUNTIME_DEPENDENCIES:
                raise RuntimeError(
                    "Auto-mask dependency import failed "
                    f"({missing_module}). Install requirements with "
                    "`python -m pip install -r requirements.txt`."
                ) from error
            raise
        model.eval()
        model.to(self.device)
        if self.device == "cuda":
            model.half()
        self._torch = torch
        self._transforms = v2.Compose(
            [
                v2.ToImage(),
                v2.ToDtype(torch.float32, scale=True),
                v2.Normalize(
                    mean=(0.485, 0.456, 0.406),
                    std=(0.229, 0.224, 0.225),
                ),
            ]
        )
        self._model = model

    def generate(self, source: Path, *, max_dimension: int | None = None) -> tuple[bytes, str]:
        self._load()
        with Image.open(source) as loaded:
            image = loaded.convert("RGB")
        requested_dimension = self.input_size if max_dimension is None else int(max_dimension)
        resolved_max_dimension = max(64, min(MAX_AUTO_MASK_DIMENSION, requested_dimension))
        scaled_image = _inference_image(image, resolved_max_dimension)
        tensor = self._transforms(scaled_image).unsqueeze(0).to(self.device)
        if self.device == "cuda":
            tensor = tensor.half()
        with self._torch.inference_mode():
            prediction = self._model(tensor)[-1].sigmoid().float().cpu()[0, 0]
        probability = Image.fromarray(
            prediction.mul(255).clamp(0, 255).to(self._torch.uint8).numpy(),
            mode="L",
        )
        background = _background_mask(
            probability,
            image.size,
            threshold=self.threshold,
        )
        rgba = Image.new("RGBA", background.size, (255, 255, 255, 0))
        rgba.putalpha(background)
        output = BytesIO()
        rgba.save(output, format="PNG")
        return output.getvalue(), self.device

    def close(self) -> None:
        if self._model is not None:
            self._model.to("cpu")
            self._model = None
        if self._torch is not None and self._torch.cuda.is_available():
            self._torch.cuda.empty_cache()
        self._torch = None
        self._transforms = None


@dataclass
class _JobState:
    request_id: int
    status: AutoMaskStatus
    requested_at: str
    updated_at: str
    started_at: str | None
    completed_at: str | None
    error: str | None
    device: str | None
    max_dimension: int
    cancel_requested: bool = False


class AutoMaskService:
    def __init__(
        self,
        root: Path,
        masks: MaskStore,
        *,
        generator: AutoMaskGenerator | None = None,
    ) -> None:
        self._root = root
        self._masks = masks
        self._generator = generator or BiRefNetAutoMaskGenerator()
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
            self._thread = threading.Thread(target=self._run, name="souvenir-auto-mask", daemon=True)
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

    def request(self, relative: Path, *, max_dimension: int = DEFAULT_AUTO_MASK_DIMENSION) -> dict[str, object]:
        path = relative.as_posix()
        resolved_max_dimension = max(64, min(MAX_AUTO_MASK_DIMENSION, int(max_dimension)))
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
            data, device = self._generator.generate(self._root / relative, max_dimension=max_dimension)
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
            self._masks.write_generated(relative, data, blur=AUTO_MASK_DEFAULT_BLUR)
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
        mask_info = self._masks.info(relative)
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
                "mask": mask_info,
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
            "mask": mask_info,
        }
