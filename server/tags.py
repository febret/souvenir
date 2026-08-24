from __future__ import annotations

import json
import os
import threading
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .media import TAG_STORAGE_FILE, normalize_relative, relative_text

MAX_TAGS = 100
MAX_TAG_NAME_LENGTH = 40
MAX_COMMENTARY_CAPTION_LENGTH = 5000
MAX_COMMENTARY_VOLUME = 4.0


class TagStore:
    """Persistent tag definitions and assignments for one media library."""

    def __init__(self, root: Path) -> None:
        self._path = root / TAG_STORAGE_FILE
        self._lock = threading.RLock()

    def list_tags(self) -> dict[str, list[dict[str, str]] | str | None]:
        with self._lock:
            state = self._load()
            return {"tags": [dict(tag) for tag in state["tags"]], "updated_at": state["updated_at"]}

    def create(self, name: object) -> dict[str, str]:
        normalized = _tag_name(name)
        with self._lock:
            state = self._load()
            if len(state["tags"]) >= MAX_TAGS:
                raise HTTPException(422, "tag limit of 100 reached")
            self._ensure_unique_name(state["tags"], normalized)
            tag = {"id": uuid.uuid4().hex, "name": normalized}
            state["tags"].append(tag)
            self._save(state)
            return dict(tag)

    def rename(self, tag_id: str, name: object) -> dict[str, str]:
        normalized = _tag_name(name)
        with self._lock:
            state = self._load()
            tag = self._find_tag(state["tags"], tag_id)
            self._ensure_unique_name(state["tags"], normalized, excluding=tag_id)
            tag["name"] = normalized
            self._save(state)
            return dict(tag)

    def delete(self, tag_id: str) -> None:
        with self._lock:
            state = self._load()
            self._find_tag(state["tags"], tag_id)
            state["tags"] = [tag for tag in state["tags"] if tag["id"] != tag_id]
            for namespace in ("media_assignments", "commentary_assignments"):
                for path, tag_ids in list(state[namespace].items()):
                    remaining = [assigned_id for assigned_id in tag_ids if assigned_id != tag_id]
                    if remaining:
                        state[namespace][path] = remaining
                    else:
                        del state[namespace][path]
            self._save(state)

    def tag_ids(self, relative: Path) -> list[str]:
        return self._tag_ids("media_assignments", relative)

    def commentary_tag_ids(self, relative: Path) -> list[str]:
        return self._tag_ids("commentary_assignments", relative)

    def assignments(self) -> dict[str, list[str]]:
        return self._assignments("media_assignments")

    def commentary_assignments(self) -> dict[str, list[str]]:
        return self._assignments("commentary_assignments")

    def commentary_captions(self) -> dict[str, str]:
        with self._lock:
            state = self._load()
            return dict(state["commentary_captions"])

    def commentary_caption(self, relative: Path) -> str:
        with self._lock:
            state = self._load()
            return state["commentary_captions"].get(relative_text(relative), "")

    def commentary_volumes(self) -> dict[str, float]:
        with self._lock:
            state = self._load()
            return dict(state["commentary_volumes"])

    def commentary_volume(self, relative: Path) -> float:
        with self._lock:
            state = self._load()
            return state["commentary_volumes"].get(relative_text(relative), 1.0)

    def replace_assignment(self, relative: Path, tag_ids: object) -> dict[str, list[str] | str]:
        return self._replace("media_assignments", relative, tag_ids)

    def replace_assignments(self, assignments: object) -> list[dict[str, list[str] | str]]:
        if not isinstance(assignments, list):
            raise HTTPException(422, "assignments must be an array")
        if not assignments:
            return []
        normalized: list[tuple[str, object]] = []
        seen_paths: set[str] = set()
        for assignment in assignments:
            if (
                not isinstance(assignment, tuple)
                or len(assignment) != 2
                or not isinstance(assignment[0], Path)
            ):
                raise HTTPException(422, "assignments must be an array of media assignments")
            path = relative_text(assignment[0])
            if path in seen_paths:
                raise HTTPException(422, "duplicate media path")
            seen_paths.add(path)
            normalized.append((path, assignment[1]))
        with self._lock:
            state = self._load()
            results = [
                {"path": path, "tag_ids": self._canonical_tag_ids(state["tags"], tag_ids)}
                for path, tag_ids in normalized
            ]
            for result in results:
                if result["tag_ids"]:
                    state["media_assignments"][result["path"]] = result["tag_ids"]
                else:
                    state["media_assignments"].pop(result["path"], None)
            self._save(state)
            return results

    def replace_commentary_assignment(self, relative: Path, tag_ids: object) -> dict[str, list[str] | str]:
        return self._replace("commentary_assignments", relative, tag_ids)

    def replace_commentary_caption(self, relative: Path, caption: object) -> dict[str, str]:
        normalized = _commentary_caption(caption)
        path = relative_text(relative)
        with self._lock:
            state = self._load()
            if normalized:
                state["commentary_captions"][path] = normalized
            else:
                state["commentary_captions"].pop(path, None)
            self._save(state)
            return {"path": path, "caption": normalized}

    def replace_commentary_volume(self, relative: Path, volume: object) -> dict[str, float | str]:
        normalized = _commentary_volume(volume)
        path = relative_text(relative)
        with self._lock:
            state = self._load()
            if normalized == 1.0:
                state["commentary_volumes"].pop(path, None)
            else:
                state["commentary_volumes"][path] = normalized
            self._save(state)
            return {"path": path, "volume": normalized}

    def _tag_ids(self, namespace: str, relative: Path) -> list[str]:
        with self._lock:
            state = self._load()
            return list(state[namespace].get(relative_text(relative), []))

    def _assignments(self, namespace: str) -> dict[str, list[str]]:
        with self._lock:
            state = self._load()
            return {path: list(tag_ids) for path, tag_ids in state[namespace].items()}

    def _replace(self, namespace: str, relative: Path, tag_ids: object) -> dict[str, list[str] | str]:
        if not isinstance(tag_ids, list) or any(not isinstance(tag_id, str) for tag_id in tag_ids):
            raise HTTPException(422, "tag_ids must be an array of strings")
        path = relative_text(relative)
        with self._lock:
            state = self._load()
            canonical = self._canonical_tag_ids(state["tags"], tag_ids)
            if canonical:
                state[namespace][path] = canonical
            else:
                state[namespace].pop(path, None)
            self._save(state)
            return {"path": path, "tag_ids": canonical}

    @staticmethod
    def _canonical_tag_ids(tags: list[dict[str, str]], tag_ids: object) -> list[str]:
        if not isinstance(tag_ids, list) or any(not isinstance(tag_id, str) for tag_id in tag_ids):
            raise HTTPException(422, "tag_ids must be an array of strings")
        known_ids = {tag["id"] for tag in tags}
        if any(tag_id not in known_ids for tag_id in tag_ids):
            raise HTTPException(422, "unknown tag ID")
        requested = set(tag_ids)
        return [tag["id"] for tag in tags if tag["id"] in requested]

    def _load(self) -> dict:
        if self._path.is_symlink() or (self._path.exists() and not self._path.is_file()):
            raise HTTPException(500, "tag storage is invalid")
        if not self._path.exists():
            return _empty_state()
        try:
            loaded = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(500, "tag storage is malformed") from error
        self._validate_state(loaded)
        if loaded["version"] == 1:
            return {
                "version": 4,
                "updated_at": loaded["updated_at"],
                "tags": loaded["tags"],
                "media_assignments": loaded["assignments"],
                "commentary_assignments": {},
                "commentary_captions": {},
                "commentary_volumes": {},
            }
        if loaded["version"] == 2:
            return {
                **loaded,
                "version": 4,
                "commentary_captions": {},
                "commentary_volumes": {},
            }
        if loaded["version"] == 3:
            return {
                **loaded,
                "version": 4,
                "commentary_volumes": {},
            }
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
            raise HTTPException(500, "tag storage could not be updated") from error

    @staticmethod
    def _cleanup(path: Path) -> None:
        try:
            path.unlink()
        except (FileNotFoundError, OSError):
            pass

    @staticmethod
    def _find_tag(tags: list[dict[str, str]], tag_id: str) -> dict[str, str]:
        for tag in tags:
            if tag["id"] == tag_id:
                return tag
        raise HTTPException(404, "tag was not found")

    @staticmethod
    def _ensure_unique_name(tags: list[dict[str, str]], name: str, *, excluding: str | None = None) -> None:
        if any(tag["id"] != excluding and tag["name"].casefold() == name.casefold() for tag in tags):
            raise HTTPException(422, "tag name already exists")

    @staticmethod
    def _validate_state(state: object) -> None:
        if not isinstance(state, dict):
            raise HTTPException(500, "tag storage is malformed")
        version = state.get("version")
        if version == 1 and not isinstance(version, bool):
            required = {"version", "updated_at", "tags", "assignments"}
            namespaces = [state.get("assignments")]
        elif version == 2 and not isinstance(version, bool):
            required = {"version", "updated_at", "tags", "media_assignments", "commentary_assignments"}
            namespaces = [state.get("media_assignments"), state.get("commentary_assignments")]
        elif version == 3 and not isinstance(version, bool):
            required = {
                "version",
                "updated_at",
                "tags",
                "media_assignments",
                "commentary_assignments",
                "commentary_captions",
            }
            namespaces = [state.get("media_assignments"), state.get("commentary_assignments")]
        elif version == 4 and not isinstance(version, bool):
            required = {
                "version",
                "updated_at",
                "tags",
                "media_assignments",
                "commentary_assignments",
                "commentary_captions",
                "commentary_volumes",
            }
            namespaces = [state.get("media_assignments"), state.get("commentary_assignments")]
        else:
            raise HTTPException(500, "tag storage is malformed")
        if set(state) != required:
            raise HTTPException(500, "tag storage is malformed")
        updated_at = state["updated_at"]
        if updated_at is not None:
            if not isinstance(updated_at, str):
                raise HTTPException(500, "tag storage is malformed")
            try:
                parsed = datetime.fromisoformat(updated_at)
            except ValueError as error:
                raise HTTPException(500, "tag storage is malformed") from error
            if parsed.tzinfo is None:
                raise HTTPException(500, "tag storage is malformed")
        tags = state["tags"]
        if not isinstance(tags, list) or len(tags) > MAX_TAGS or any(not isinstance(value, dict) for value in namespaces):
            raise HTTPException(500, "tag storage is malformed")
        tag_ids: list[str] = []
        names: set[str] = set()
        for tag in tags:
            if not isinstance(tag, dict) or set(tag) != {"id", "name"}:
                raise HTTPException(500, "tag storage is malformed")
            tag_id = tag["id"]
            if not isinstance(tag_id, str) or len(tag_id) != 32:
                raise HTTPException(500, "tag storage is malformed")
            try:
                if uuid.UUID(hex=tag_id).hex != tag_id:
                    raise ValueError
            except ValueError as error:
                raise HTTPException(500, "tag storage is malformed") from error
            try:
                name = _tag_name(tag["name"])
            except HTTPException as error:
                raise HTTPException(500, "tag storage is malformed") from error
            if name != tag["name"] or name.casefold() in names or tag_id in tag_ids:
                raise HTTPException(500, "tag storage is malformed")
            names.add(name.casefold())
            tag_ids.append(tag_id)
        for assignments in namespaces:
            for path, assigned_ids in assignments.items():
                _validate_assignment(path, assigned_ids, tag_ids)
        if version in (3, 4):
            captions = state["commentary_captions"]
            if not isinstance(captions, dict):
                raise HTTPException(500, "tag storage is malformed")
            for path, caption in captions.items():
                _validate_commentary_caption(path, caption)
        if version == 4:
            volumes = state["commentary_volumes"]
            if not isinstance(volumes, dict):
                raise HTTPException(500, "tag storage is malformed")
            for path, volume in volumes.items():
                _validate_commentary_volume(path, volume)


def _empty_state() -> dict:
    return {
        "version": 4,
        "updated_at": None,
        "tags": [],
        "media_assignments": {},
        "commentary_assignments": {},
        "commentary_captions": {},
        "commentary_volumes": {},
    }


def _validate_assignment(path: object, assigned_ids: object, tag_ids: list[str]) -> None:
    if not isinstance(path, str) or not path:
        raise HTTPException(500, "tag storage is malformed")
    try:
        if relative_text(normalize_relative(path)) != path:
            raise HTTPException(500, "tag storage is malformed")
    except HTTPException as error:
        raise HTTPException(500, "tag storage is malformed") from error
    if not isinstance(assigned_ids, list) or any(not isinstance(tag_id, str) for tag_id in assigned_ids):
        raise HTTPException(500, "tag storage is malformed")
    if any(tag_id not in tag_ids for tag_id in assigned_ids):
        raise HTTPException(500, "tag storage is malformed")
    canonical = [tag_id for tag_id in tag_ids if tag_id in set(assigned_ids)]
    if assigned_ids != canonical:
        raise HTTPException(500, "tag storage is malformed")


def _tag_name(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "tag name must be a string")
    name = value.strip()
    if not 1 <= len(name) <= MAX_TAG_NAME_LENGTH:
        raise HTTPException(422, "tag name must be 1 to 40 characters")
    if any(unicodedata.category(character) == "Cc" for character in name):
        raise HTTPException(422, "tag name must not contain control characters")
    return name


def _commentary_caption(value: object) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, "caption must be a string")
    caption = value.strip()
    if len(caption) > MAX_COMMENTARY_CAPTION_LENGTH:
        raise HTTPException(422, "caption must be no more than 5000 characters")
    if any(
        unicodedata.category(character) == "Cc" and character not in "\n\r\t"
        for character in caption
    ):
        raise HTTPException(422, "caption must not contain control characters")
    return caption


def _validate_commentary_caption(path: object, caption: object) -> None:
    _validate_assignment(path, [], [])
    try:
        normalized = _commentary_caption(caption)
    except HTTPException as error:
        raise HTTPException(500, "tag storage is malformed") from error
    if not normalized or normalized != caption:
        raise HTTPException(500, "tag storage is malformed")


def _commentary_volume(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise HTTPException(422, "volume must be a number")
    volume = float(value)
    if not 0 <= volume <= MAX_COMMENTARY_VOLUME:
        raise HTTPException(422, "volume must be between 0 and 2")
    return round(volume, 2)


def _validate_commentary_volume(path: object, volume: object) -> None:
    _validate_assignment(path, [], [])
    try:
        normalized = _commentary_volume(volume)
    except HTTPException as error:
        raise HTTPException(500, "tag storage is malformed") from error
    if normalized != volume or normalized == 1.0:
        raise HTTPException(500, "tag storage is malformed")
