from __future__ import annotations

import json
import math
import os
import threading
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .media import SCENE_STORAGE_FILE

MIN_DURATION_SECONDS = 1
MAX_DURATION_SECONDS = 60
DEFAULT_DURATION_SECONDS = 8
MAX_SCENE_NAME_LENGTH = 80


def _vector3(value: object, *, field: str) -> dict[str, float]:
    if not isinstance(value, dict):
        raise HTTPException(422, f"{field} must be an object")
    result: dict[str, float] = {}
    for axis in ("x", "y", "z"):
        component = value.get(axis)
        if isinstance(component, bool) or not isinstance(component, (int, float)):
            raise HTTPException(422, f"{field}.{axis} must be a number")
        if not math.isfinite(component):
            raise HTTPException(422, f"{field}.{axis} must be finite")
        result[axis] = float(component)
    if set(value) != {"x", "y", "z"}:
        raise HTTPException(422, f"{field} must contain only x, y, z")
    return result


def _dimensions(value: object) -> dict[str, float]:
    if not isinstance(value, dict) or set(value) != {"width", "height"}:
        raise HTTPException(422, "dimensions must contain width and height")
    width = value.get("width")
    height = value.get("height")
    if isinstance(width, bool) or not isinstance(width, (int, float)):
        raise HTTPException(422, "dimensions.width must be a number")
    if isinstance(height, bool) or not isinstance(height, (int, float)):
        raise HTTPException(422, "dimensions.height must be a number")
    if not math.isfinite(width) or not math.isfinite(height):
        raise HTTPException(422, "dimensions must be finite")
    if width <= 0 or height <= 0:
        raise HTTPException(422, "dimensions must be positive")
    return {"width": float(width), "height": float(height)}


def _scene_name(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "scene name must be a string")
    normalized = value.strip()
    if not 1 <= len(normalized) <= MAX_SCENE_NAME_LENGTH:
        raise HTTPException(422, "scene name must be 1 to 80 characters")
    if any(unicodedata.category(character) == "Cc" for character in normalized):
        raise HTTPException(422, "scene name must not contain control characters")
    return normalized


def _duration_seconds(value: object, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise HTTPException(422, f"{field} must be an integer")
    if value < MIN_DURATION_SECONDS or value > MAX_DURATION_SECONDS:
        raise HTTPException(
            422,
            f"{field} must be between {MIN_DURATION_SECONDS} and {MAX_DURATION_SECONDS}",
        )
    return value


def _panel_snapshot(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "panel snapshot must be an object")
    required = {"id", "media", "transform", "dimensions"}
    if set(value) != required:
        raise HTTPException(422, "panel snapshot contains unexpected fields")
    panel_id = value.get("id")
    if not isinstance(panel_id, str) or not panel_id.strip():
        raise HTTPException(422, "panel id must be a non-empty string")
    media = value.get("media")
    if not isinstance(media, dict) or set(media) != {"directory", "selectedId", "sort", "view"}:
        raise HTTPException(422, "panel media snapshot is malformed")
    directory = media.get("directory")
    selected_id = media.get("selectedId")
    sort = media.get("sort")
    view = media.get("view")
    if directory is not None and (not isinstance(directory, str) or not directory):
        raise HTTPException(422, "panel media.directory must be null or a non-empty string")
    if selected_id is not None and (not isinstance(selected_id, str) or not selected_id):
        raise HTTPException(422, "panel media.selectedId must be null or a non-empty string")
    if not isinstance(sort, str) or not sort:
        raise HTTPException(422, "panel media.sort must be a non-empty string")
    if not isinstance(view, str) or not view:
        raise HTTPException(422, "panel media.view must be a non-empty string")
    transform = value.get("transform")
    if not isinstance(transform, dict) or set(transform) != {"position", "rotation"}:
        raise HTTPException(422, "panel transform snapshot is malformed")
    return {
        "id": panel_id.strip(),
        "media": {
            "directory": directory,
            "selectedId": selected_id,
            "sort": sort,
            "view": view,
        },
        "transform": {
            "position": _vector3(transform.get("position"), field="transform.position"),
            "rotation": _vector3(transform.get("rotation"), field="transform.rotation"),
        },
        "dimensions": _dimensions(value.get("dimensions")),
    }


def _shot(value: object) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "shot must be an object")
    required = {"id", "duration_sec", "panels"}
    if set(value) != required:
        raise HTTPException(422, "shot contains unexpected fields")
    shot_id = value.get("id")
    if not isinstance(shot_id, str) or len(shot_id) != 32:
        raise HTTPException(422, "shot id must be a 32-character hex string")
    try:
        if uuid.UUID(hex=shot_id).hex != shot_id:
            raise ValueError
    except ValueError as error:
        raise HTTPException(422, "shot id must be a 32-character hex string") from error
    panels = value.get("panels")
    if not isinstance(panels, list):
        raise HTTPException(422, "shot panels must be an array")
    seen_panel_ids: set[str] = set()
    normalized_panels: list[dict] = []
    for panel in panels:
        normalized = _panel_snapshot(panel)
        if normalized["id"] in seen_panel_ids:
            raise HTTPException(422, "shot panels must have unique ids")
        seen_panel_ids.add(normalized["id"])
        normalized_panels.append(normalized)
    return {
        "id": shot_id,
        "duration_sec": _duration_seconds(value.get("duration_sec"), field="duration_sec"),
        "panels": normalized_panels,
    }


def _scene_body(value: object, *, existing_name: str) -> dict:
    if not isinstance(value, dict):
        raise HTTPException(422, "request body must be a JSON object")
    required = {"loop", "default_duration_sec", "current_shot_id", "shots"}
    if set(value) != required:
        raise HTTPException(
            422,
            "request body must contain only current_shot_id, default_duration_sec, loop, shots",
        )
    loop = value.get("loop")
    if not isinstance(loop, bool):
        raise HTTPException(422, "loop must be a boolean")
    current_shot_id = value.get("current_shot_id")
    if current_shot_id is not None and (
        not isinstance(current_shot_id, str) or len(current_shot_id) != 32
    ):
        raise HTTPException(422, "current_shot_id must be null or a 32-character hex string")
    shots = value.get("shots")
    if not isinstance(shots, list):
        raise HTTPException(422, "shots must be an array")
    normalized_shots: list[dict] = []
    seen_shot_ids: set[str] = set()
    for shot_value in shots:
        normalized = _shot(shot_value)
        if normalized["id"] in seen_shot_ids:
            raise HTTPException(422, "shots must have unique ids")
        seen_shot_ids.add(normalized["id"])
        normalized_shots.append(normalized)
    if current_shot_id is not None and current_shot_id not in seen_shot_ids:
        raise HTTPException(422, "current_shot_id must refer to an existing shot")
    return {
        "name": existing_name,
        "loop": loop,
        "default_duration_sec": _duration_seconds(
            value.get("default_duration_sec"),
            field="default_duration_sec",
        ),
        "current_shot_id": current_shot_id,
        "shots": normalized_shots,
    }


def _empty_state() -> dict:
    return {
        "version": 1,
        "updated_at": None,
        "scenes": [],
    }


class SceneStore:
    def __init__(self, root: Path) -> None:
        self._path = root / SCENE_STORAGE_FILE
        self._lock = threading.RLock()

    def list_scenes(self) -> dict:
        with self._lock:
            state = self._load()
            scenes = [
                {
                    "id": scene["id"],
                    "name": scene["name"],
                    "loop": scene["loop"],
                    "default_duration_sec": scene["default_duration_sec"],
                    "shot_count": len(scene["shots"]),
                    "updated_at": scene["updated_at"],
                }
                for scene in state["scenes"]
            ]
            return {"scenes": scenes, "updated_at": state["updated_at"]}

    def create_scene(self, name: object) -> dict:
        normalized_name = _scene_name(name)
        with self._lock:
            state = self._load()
            if any(scene["name"].casefold() == normalized_name.casefold() for scene in state["scenes"]):
                raise HTTPException(422, "scene name already exists")
            scene = {
                "id": uuid.uuid4().hex,
                "name": normalized_name,
                "loop": True,
                "default_duration_sec": DEFAULT_DURATION_SECONDS,
                "current_shot_id": None,
                "shots": [],
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
            state["scenes"].append(scene)
            self._save(state)
            return self._public_scene(scene)

    def get_scene(self, scene_id: str) -> dict:
        with self._lock:
            state = self._load()
            scene = self._find_scene(state, scene_id)
            return self._public_scene(scene)

    def replace_scene(self, scene_id: str, body: object) -> dict:
        with self._lock:
            state = self._load()
            scene = self._find_scene(state, scene_id)
            normalized = _scene_body(body, existing_name=scene["name"])
            scene.update(normalized)
            scene["updated_at"] = datetime.now(timezone.utc).isoformat()
            self._save(state)
            return self._public_scene(scene)

    def _public_scene(self, scene: dict) -> dict:
        return {
            "id": scene["id"],
            "name": scene["name"],
            "loop": scene["loop"],
            "default_duration_sec": scene["default_duration_sec"],
            "current_shot_id": scene["current_shot_id"],
            "shots": [
                {
                    "id": shot["id"],
                    "duration_sec": shot["duration_sec"],
                    "panels": [dict(panel) for panel in shot["panels"]],
                }
                for shot in scene["shots"]
            ],
            "updated_at": scene["updated_at"],
        }

    def _find_scene(self, state: dict, scene_id: str) -> dict:
        if not isinstance(scene_id, str) or len(scene_id) != 32:
            raise HTTPException(404, "scene was not found")
        for scene in state["scenes"]:
            if scene["id"] == scene_id:
                return scene
        raise HTTPException(404, "scene was not found")

    def _load(self) -> dict:
        if self._path.is_symlink() or (self._path.exists() and not self._path.is_file()):
            raise HTTPException(500, "scene storage is invalid")
        if not self._path.exists():
            return _empty_state()
        try:
            loaded = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(500, "scene storage is malformed") from error
        self._validate_state(loaded)
        return loaded

    def _save(self, state: dict) -> None:
        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        temporary = self._path.parent / f".{self._path.name}.{uuid.uuid4().hex}.tmp"
        try:
            encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            with temporary.open("xb") as handle:
                handle.write(encoded)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._path)
        except OSError as error:
            self._cleanup(temporary)
            raise HTTPException(500, "scene storage could not be updated") from error

    @staticmethod
    def _cleanup(path: Path) -> None:
        try:
            path.unlink()
        except (FileNotFoundError, OSError):
            pass

    @staticmethod
    def _validate_state(state: object) -> None:
        if not isinstance(state, dict):
            raise HTTPException(500, "scene storage is malformed")
        required = {"version", "updated_at", "scenes"}
        if set(state) != required or state.get("version") != 1:
            raise HTTPException(500, "scene storage is malformed")
        updated_at = state.get("updated_at")
        if updated_at is not None:
            if not isinstance(updated_at, str):
                raise HTTPException(500, "scene storage is malformed")
            try:
                parsed = datetime.fromisoformat(updated_at)
            except ValueError as error:
                raise HTTPException(500, "scene storage is malformed") from error
            if parsed.tzinfo is None:
                raise HTTPException(500, "scene storage is malformed")
        scenes = state.get("scenes")
        if not isinstance(scenes, list):
            raise HTTPException(500, "scene storage is malformed")
        names: set[str] = set()
        ids: set[str] = set()
        for scene in scenes:
            if not isinstance(scene, dict):
                raise HTTPException(500, "scene storage is malformed")
            expected = {
                "id",
                "name",
                "loop",
                "default_duration_sec",
                "current_shot_id",
                "shots",
                "updated_at",
            }
            if set(scene) != expected:
                raise HTTPException(500, "scene storage is malformed")
            scene_id = scene["id"]
            if not isinstance(scene_id, str) or len(scene_id) != 32 or scene_id in ids:
                raise HTTPException(500, "scene storage is malformed")
            try:
                if uuid.UUID(hex=scene_id).hex != scene_id:
                    raise ValueError
            except ValueError as error:
                raise HTTPException(500, "scene storage is malformed") from error
            ids.add(scene_id)
            try:
                name = _scene_name(scene["name"])
                if name != scene["name"] or name.casefold() in names:
                    raise HTTPException(500, "scene storage is malformed")
            except HTTPException as error:
                raise HTTPException(500, "scene storage is malformed") from error
            names.add(name.casefold())
            if not isinstance(scene["loop"], bool):
                raise HTTPException(500, "scene storage is malformed")
            try:
                if (
                    _duration_seconds(
                        scene["default_duration_sec"],
                        field="default_duration_sec",
                    )
                    != scene["default_duration_sec"]
                ):
                    raise HTTPException(500, "scene storage is malformed")
            except HTTPException as error:
                raise HTTPException(500, "scene storage is malformed") from error
            current_shot_id = scene["current_shot_id"]
            if current_shot_id is not None and (
                not isinstance(current_shot_id, str) or len(current_shot_id) != 32
            ):
                raise HTTPException(500, "scene storage is malformed")
            updated_at = scene["updated_at"]
            if not isinstance(updated_at, str):
                raise HTTPException(500, "scene storage is malformed")
            try:
                parsed_scene_time = datetime.fromisoformat(updated_at)
            except ValueError as error:
                raise HTTPException(500, "scene storage is malformed") from error
            if parsed_scene_time.tzinfo is None:
                raise HTTPException(500, "scene storage is malformed")
            shots = scene["shots"]
            if not isinstance(shots, list):
                raise HTTPException(500, "scene storage is malformed")
            shot_ids: set[str] = set()
            for shot in shots:
                try:
                    normalized = _shot(shot)
                except HTTPException as error:
                    raise HTTPException(500, "scene storage is malformed") from error
                if normalized != shot:
                    raise HTTPException(500, "scene storage is malformed")
                shot_ids.add(normalized["id"])
            if current_shot_id is not None and current_shot_id not in shot_ids:
                raise HTTPException(500, "scene storage is malformed")
