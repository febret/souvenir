from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse

from .auto_depth import AutoDepthGenerator
from .auto_mask import AutoMaskGenerator
from .config import commentary_dir, library_id, load_settings, upload_dirname
from .library import LibraryScanService, LibraryScanner
from .routes import add_routes


def _suppress_windows_connection_reset_noise() -> tuple[asyncio.AbstractEventLoop, object | None]:
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()

    def _handler(active_loop: asyncio.AbstractEventLoop, context: dict[str, object]) -> None:
        exception = context.get("exception")
        handle = context.get("handle")
        callback = getattr(handle, "_callback", None)
        callback_name = getattr(callback, "__qualname__", "")
        if (
            isinstance(exception, ConnectionResetError)
            and getattr(exception, "winerror", None) == 10054
            and "_ProactorBasePipeTransport._call_connection_lost" in callback_name
        ):
            return
        if previous_handler is not None:
            previous_handler(active_loop, context)
            return
        active_loop.default_exception_handler(context)

    loop.set_exception_handler(_handler)
    return loop, previous_handler


def create_app(
    media_home: str | Path | None = None,
    *,
    library_scanner: LibraryScanner | None = None,
    commentary_home: str | Path | None = None,
    upload_dirname_override: str | None = None,
    auto_mask_generator: AutoMaskGenerator | None = None,
    auto_depth_generator: AutoDepthGenerator | None = None,
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
    upload_subdir = (
        upload_dirname_override
        if upload_dirname_override is not None
        else (settings.upload_dirname if settings is not None else upload_dirname())
    )
    upload_root = root / upload_subdir
    if commentary_root is not None and not commentary_root.is_dir():
        raise ValueError(f"commentary_home must be an existing directory: {commentary_root}")
    library_scan = LibraryScanService(root, library_scanner) if library_scanner else LibraryScanService(root)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        loop, previous_handler = _suppress_windows_connection_reset_noise()
        app.state.library_scan.start()
        app.state.auto_mask_service.start()
        app.state.auto_depth_service.start()
        try:
            yield
        finally:
            app.state.auto_depth_service.stop()
            app.state.auto_mask_service.stop()
            loop.set_exception_handler(previous_handler)

    app = FastAPI(title="Souvenir", version="1.0.0", lifespan=lifespan)
    app.state.media_home = root
    app.state.commentary_home = commentary_root
    app.state.upload_home = upload_root
    app.state.upload_dirname = upload_subdir
    app.state.library_id = library_id(root)
    app.state.library_scan = library_scan
    add_routes(
        app,
        root,
        commentary_root,
        upload_root=upload_root,
        auto_mask_generator=auto_mask_generator,
        auto_depth_generator=auto_depth_generator,
    )
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
