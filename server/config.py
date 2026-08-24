from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path

MEDIA_HOME_ENV = "SOUVENIR_MEDIA_HOME"
COMMENTARY_DIR_ENV = "SOUVENIR_COMMENTARY_DIR"
PORT_ENV = "SOUVENIR_PORT"
LIBRARY_ID_PREFIX = "root-v1"


@dataclass(frozen=True)
class Settings:
    media_home: Path
    port: int = 8000
    commentary_dir: Path | None = None


def library_id(media_home: str | Path) -> str:
    root = Path(media_home).expanduser().resolve()
    canonical_root = os.path.normcase(str(root))
    digest = hashlib.sha256(canonical_root.encode("utf-8")).hexdigest()
    return f"{LIBRARY_ID_PREFIX}:{digest[:24]}"


def load_settings() -> Settings:
    value = os.environ.get(MEDIA_HOME_ENV)
    if not value:
        raise RuntimeError(f"{MEDIA_HOME_ENV} is required")
    media_home = Path(value).expanduser().resolve()
    if not media_home.is_dir():
        raise RuntimeError(f"{MEDIA_HOME_ENV} must be an existing directory: {media_home}")
    port_value = os.environ.get(PORT_ENV, "8000")
    try:
        port = int(port_value)
    except ValueError as error:
        raise RuntimeError(f"{PORT_ENV} must be an integer") from error
    if not 1 <= port <= 65535:
        raise RuntimeError(f"{PORT_ENV} must be between 1 and 65535")
    return Settings(media_home=media_home, port=port, commentary_dir=commentary_dir())


def commentary_dir() -> Path | None:
    value = os.environ.get(COMMENTARY_DIR_ENV)
    if value is None:
        return None
    if not value.strip():
        raise RuntimeError(f"{COMMENTARY_DIR_ENV} must be an existing directory")
    root = Path(value).expanduser().resolve()
    if not root.is_dir():
        raise RuntimeError(f"{COMMENTARY_DIR_ENV} must be an existing directory: {root}")
    return root
