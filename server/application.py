from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from .config import commentary_dir, library_id, load_settings
from .library import LibraryScanService, LibraryScanner
from .routes import add_routes


def create_app(
    media_home: str | Path | None = None,
    *,
    library_scanner: LibraryScanner | None = None,
    commentary_home: str | Path | None = None,
) -> FastAPI:
    settings = load_settings() if media_home is None else None
    root = Path(media_home).expanduser().resolve() if media_home is not None else settings.media_home
    if not root.is_dir():
        raise ValueError(f"media_home must be an existing directory: {root}")
    commentary_root = (
        Path(commentary_home).expanduser().resolve()
        if commentary_home is not None
        else (settings.commentary_dir if settings is not None else commentary_dir())
    )
    if commentary_root is not None and not commentary_root.is_dir():
        raise ValueError(f"commentary_home must be an existing directory: {commentary_root}")
    library_scan = LibraryScanService(root, library_scanner) if library_scanner else LibraryScanService(root)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.library_scan.start()
        yield

    app = FastAPI(title="Souvenir", version="1.0.0", lifespan=lifespan)
    app.state.media_home = root
    app.state.commentary_home = commentary_root
    app.state.library_id = library_id(root)
    app.state.library_scan = library_scan
    add_routes(app, root, commentary_root)
    _add_static_application(app)
    return app


def _add_static_application(app: FastAPI) -> None:
    static_root = Path(__file__).resolve().parent.parent / "app"
    if (static_root / "dist").is_dir():
        static_root = static_root / "dist"
    if not static_root.is_dir():
        return
    index = static_root / "index.html"

    @app.get("/{asset_path:path}", include_in_schema=False)
    def static_application(asset_path: str = ""):
        candidate = (static_root / asset_path).resolve()
        try:
            candidate.relative_to(static_root.resolve())
        except ValueError:
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        if candidate.is_file():
            return FileResponse(candidate)
        if index.is_file():
            return FileResponse(index)
        return JSONResponse({"detail": "Not Found"}, status_code=404)
