from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Iterator

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse

from .auto_depth import AutoDepthGenerator, AutoDepthService
from .auto_mask import AutoMaskGenerator, AutoMaskService
from .commentary import commentary_entries, commentary_type, resolve_commentary_file
from .depth_maps import MAX_DEPTH_MAP_BYTES, DepthMapStore
from .media import content_type, is_allowed, is_internal_path, is_media, media_type, metadata, parse_included_dirs, relative_text, resolve_under_root
from .scenes import SceneStore
from .masks import MAX_MASK_BYTES, MaskStore
from .tags import DEFAULT_ADM_DEPTH_INTENSITY, TagStore
from .thumbnails import create_thumbnail

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _included(root: Path, include: list[str], included_dirs: list[str]) -> tuple[Path, ...]:
    return parse_included_dirs([*include, *included_dirs], root)


def _visible_children(root: Path, directory: Path, included: tuple[Path, ...]) -> list[Path]:
    result: list[Path] = []
    for child in directory.iterdir():
        if is_internal_path(child.relative_to(root)):
            continue
        try:
            resolved, relative = resolve_under_root(root, child.relative_to(root))
        except (HTTPException, OSError, RuntimeError, ValueError):
            continue
        if is_allowed(relative, included) and (resolved.is_dir() or is_media(resolved)):
            result.append(resolved)
    return sorted(result, key=lambda item: (not item.is_dir(), item.name.casefold()))


def _tree(root: Path, directory: Path, included: tuple[Path, ...]) -> dict:
    item = metadata(root, directory)
    item["children"] = [
        _tree(root, child, included)
        for child in _visible_children(root, directory, included) if child.is_dir()
    ]
    return item


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    match = _RANGE.fullmatch(header.strip())
    if not match or size == 0:
        return None
    start_text, end_text = match.groups()
    if not start_text and not end_text:
        return None
    if start_text:
        start = int(start_text)
        end = int(end_text) if end_text else size - 1
        if start >= size or end < start:
            return None
        return start, min(end, size - 1)
    suffix = int(end_text)
    if suffix <= 0:
        return None
    return max(0, size - suffix), size - 1


def _file_chunks(path: Path, start: int, length: int, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining:
            data = handle.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


def _stream_media(path: Path, request: Request, *, response_media_type: str | None = None) -> Response:
    size = path.stat().st_size
    response_media_type = response_media_type or content_type(path)
    headers = {"Accept-Ranges": "bytes"}
    range_header = request.headers.get("range")
    if range_header is None:
        headers["Content-Length"] = str(size)
        if request.method == "HEAD":
            return Response(status_code=200, headers=headers, media_type=response_media_type)
        return StreamingResponse(_file_chunks(path, 0, size), status_code=200, headers=headers, media_type=response_media_type)
    selected = _parse_range(range_header, size)
    if selected is None:
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"})
    start, end = selected
    length = end - start + 1
    headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
    if request.method == "HEAD":
        return Response(status_code=206, headers=headers, media_type=response_media_type)
    return StreamingResponse(_file_chunks(path, start, length), status_code=206, headers=headers, media_type=response_media_type)


def add_routes(
    app: FastAPI,
    root: Path,
    commentary_root: Path | None = None,
    *,
    auto_mask_generator: AutoMaskGenerator | None = None,
    auto_depth_generator: AutoDepthGenerator | None = None,
) -> None:
    masks = MaskStore(root)
    auto_masks = AutoMaskService(root, masks, generator=auto_mask_generator)
    depth_maps = DepthMapStore(root)
    auto_depth = AutoDepthService(root, depth_maps, generator=auto_depth_generator)
    app.state.auto_mask_service = auto_masks
    app.state.auto_depth_service = auto_depth
    tags = TagStore(root)
    scenes = SceneStore(root)

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok", "media_home": str(root), "library_id": app.state.library_id}

    @app.get("/api/library-status")
    def library_status() -> dict:
        return {**app.state.library_scan.progress.snapshot(), "library_id": app.state.library_id}

    @app.get("/api/tree")
    def directory_tree(include: list[str] = Query(default=[]), included_dirs: list[str] = Query(default=[])) -> dict:
        allowed = _included(root, include, included_dirs)
        return _tree(root, root, allowed)

    @app.get("/api/media")
    def directory_listing(path: str = "", include: list[str] = Query(default=[]), included_dirs: list[str] = Query(default=[])) -> dict:
        directory, relative = resolve_under_root(root, path, directory=True)
        _reject_internal_path(relative)
        allowed = _included(root, include, included_dirs)
        assignments = tags.assignments()
        adm_settings = tags.media_adm_settings()
        entries = [
            metadata(
                root,
                child,
                tag_ids=assignments.get(relative_text(child.relative_to(root)), []) if child.is_file() else [],
            )
            for child in _visible_children(root, directory, allowed)
        ]
        for entry in entries:
            if entry["kind"] != "file" or not entry["media_type"] or not entry["media_type"].startswith("image/"):
                continue
            setting = adm_settings.get(entry["path"])
            entry["adm"] = {
                "configured": isinstance(setting, dict),
                "enabled": bool(setting["enabled"]) if isinstance(setting, dict) else False,
                "depth_intensity": float(setting["depth_intensity"]) if isinstance(setting, dict) else DEFAULT_ADM_DEPTH_INTENSITY,
            }
        return {"path": relative_text(relative), "entries": entries, "directories": [entry for entry in entries if entry["kind"] == "directory"], "files": [entry for entry in entries if entry["kind"] == "file"]}

    @app.get("/api/tags")
    def list_tags():
        return _no_store(tags.list_tags())

    @app.post("/api/tags", status_code=201)
    async def create_tag(request: Request):
        body = await _json_object(request)
        _require_exact_keys(body, {"name"})
        return tags.create(body["name"])

    @app.patch("/api/tags/{tag_id}")
    async def rename_tag(tag_id: str, request: Request):
        body = await _json_object(request)
        _require_exact_keys(body, {"name"})
        return tags.rename(tag_id, body["name"])

    @app.delete("/api/tags/{tag_id}", status_code=204)
    def delete_tag(tag_id: str) -> Response:
        tags.delete(tag_id)
        return Response(status_code=204)

    @app.get("/api/media-tags")
    def get_media_tags(path: str):
        relative = _media_relative(root, path)
        return _no_store({"path": relative_text(relative), "tag_ids": tags.tag_ids(relative)})

    @app.put("/api/media-tags")
    async def put_media_tags(path: str, request: Request):
        relative = _media_relative(root, path)
        body = await _json_object(request)
        _require_exact_keys(body, {"tag_ids"})
        return _no_store(tags.replace_assignment(relative, body["tag_ids"]))

    @app.get("/api/media-adm")
    def get_media_adm(path: str):
        relative = _image_relative(root, path)
        return _no_store(tags.media_adm_setting(relative))

    @app.put("/api/media-adm")
    async def put_media_adm(path: str, request: Request):
        relative = _image_relative(root, path)
        body = await _json_object(request)
        _require_exact_keys(body, {"enabled", "depth_intensity"})
        return _no_store(
            tags.replace_media_adm_setting(
                relative,
                enabled=body["enabled"],
                depth_intensity=body["depth_intensity"],
            )
        )

    @app.put("/api/media-tags/bulk")
    async def put_media_tags_bulk(request: Request):
        body = await _json_object(request)
        _require_exact_keys(body, {"assignments"})
        raw_assignments = body["assignments"]
        if not isinstance(raw_assignments, list):
            raise HTTPException(422, "assignments must be an array")
        assignments: list[tuple[Path, object]] = []
        seen_paths: set[str] = set()
        for assignment in raw_assignments:
            if not isinstance(assignment, dict):
                raise HTTPException(422, "each assignment must be a JSON object")
            _require_exact_keys(assignment, {"path", "tag_ids"})
            path = assignment.get("path")
            if not isinstance(path, str):
                raise HTTPException(422, "path must be a string")
            relative = _media_relative(root, path)
            canonical_path = relative_text(relative)
            if canonical_path in seen_paths:
                raise HTTPException(422, "duplicate media path")
            seen_paths.add(canonical_path)
            assignments.append((relative, assignment["tag_ids"]))
        return _no_store({"assignments": tags.replace_assignments(assignments)})

    @app.get("/api/scenes")
    def list_scenes() -> Response:
        return _no_store(scenes.list_scenes())

    @app.post("/api/scenes", status_code=201)
    async def create_scene(request: Request) -> Response:
        body = await _json_object(request)
        _require_exact_keys(body, {"name"})
        return _no_store(scenes.create_scene(body["name"]), status_code=201)

    @app.get("/api/scenes/{scene_id}")
    def get_scene(scene_id: str) -> Response:
        return _no_store(scenes.get_scene(scene_id))

    @app.put("/api/scenes/{scene_id}")
    async def put_scene(scene_id: str, request: Request) -> Response:
        body = await _json_object(request)
        return _no_store(scenes.replace_scene(scene_id, body))

    @app.get("/api/commentary")
    def list_commentary() -> Response:
        if commentary_root is None:
            return _no_store({"available": False, "entries": []})
        return _no_store({
            "available": True,
            "entries": commentary_entries(
                commentary_root,
                tags.commentary_assignments(),
                tags.commentary_captions(),
                tags.commentary_volumes(),
            ),
        })

    @app.api_route("/api/commentary/file", methods=["GET", "HEAD"])
    def commentary_file(path: str, request: Request) -> Response:
        source, _ = _commentary_relative(commentary_root, path)
        return _stream_media(source, request, response_media_type=commentary_type(source))

    @app.get("/api/commentary-tags")
    def get_commentary_tags(path: str) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        return _no_store({"path": relative_text(relative), "tag_ids": tags.commentary_tag_ids(relative)})

    @app.put("/api/commentary-tags")
    async def put_commentary_tags(path: str, request: Request) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        body = await _json_object(request)
        _require_exact_keys(body, {"tag_ids"})
        return _no_store(tags.replace_commentary_assignment(relative, body["tag_ids"]))

    @app.get("/api/commentary-caption")
    def get_commentary_caption(path: str) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        return _no_store({
            "path": relative_text(relative),
            "caption": tags.commentary_caption(relative),
        })

    @app.put("/api/commentary-caption")
    async def put_commentary_caption(path: str, request: Request) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        body = await _json_object(request)
        _require_exact_keys(body, {"caption"})
        return _no_store(tags.replace_commentary_caption(relative, body["caption"]))

    @app.get("/api/commentary-volume")
    def get_commentary_volume(path: str) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        return _no_store({
            "path": relative_text(relative),
            "volume": tags.commentary_volume(relative),
        })

    @app.put("/api/commentary-volume")
    async def put_commentary_volume(path: str, request: Request) -> Response:
        _, relative = _commentary_relative(commentary_root, path)
        body = await _json_object(request)
        _require_exact_keys(body, {"volume"})
        return _no_store(tags.replace_commentary_volume(relative, body["volume"]))

    @app.api_route("/api/file", methods=["GET", "HEAD"])
    def media(path: str, request: Request):
        source, relative = resolve_under_root(root, path, directory=False)
        _reject_internal_path(relative)
        if not media_type(source):
            raise HTTPException(404, "unsupported media type")
        return _stream_media(source, request)

    @app.get("/api/thumbnail")
    def thumbnail(path: str):
        source, relative = resolve_under_root(root, path, directory=False)
        _reject_internal_path(relative)
        if not media_type(source):
            raise HTTPException(404, "unsupported media type")
        try:
            cached = create_thumbnail(root, source, relative)
        except OSError as error:
            raise HTTPException(500, "thumbnail generation failed") from error
        return FileResponse(cached, media_type="image/jpeg", headers={"Cache-Control": "private, max-age=3600"})

    @app.get("/api/mask-info")
    def mask_info(path: str):
        relative = masks.media_relative(path)
        return Response(
            content=json_response(masks.info(relative)),
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/mask")
    def get_mask(path: str):
        relative = masks.media_relative(path)
        return Response(content=masks.read(relative), media_type="image/png", headers={"Cache-Control": "no-store"})

    @app.put("/api/mask")
    async def put_mask(path: str, request: Request, blur: int = Query(default=0, ge=0, le=64)):
        relative = masks.media_relative(path)
        content_type_header = request.headers.get("content-type", "")
        if content_type_header.split(";", 1)[0].strip().lower() != "image/png":
            raise HTTPException(415, "mask content type must be image/png")
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise HTTPException(400, "invalid Content-Length") from error
            if declared_length < 0:
                raise HTTPException(400, "invalid Content-Length")
            if declared_length > MAX_MASK_BYTES:
                raise HTTPException(413, "mask body is too large")
        body = await _read_mask_body(request)
        return masks.write(relative, body, blur)

    @app.delete("/api/mask")
    def delete_mask(path: str):
        relative = masks.media_relative(path)
        return masks.delete(relative)

    @app.post("/api/mask/auto")
    def request_auto_mask(path: str):
        relative = _image_relative(root, path)
        return _no_store(auto_masks.request(relative))

    @app.get("/api/mask/auto")
    def auto_mask_status(path: str):
        relative = _image_relative(root, path)
        return _no_store(auto_masks.status(relative))

    @app.delete("/api/mask/auto")
    def cancel_auto_mask(path: str):
        relative = _image_relative(root, path)
        return _no_store(auto_masks.cancel(relative))

    @app.get("/api/depth-info")
    def depth_info(path: str):
        relative = depth_maps.image_relative(path)
        return Response(
            content=json_response(depth_maps.info(relative)),
            media_type="application/json",
            headers={"Cache-Control": "no-store"},
        )

    @app.get("/api/depth")
    def get_depth(path: str):
        relative = depth_maps.image_relative(path)
        return Response(content=depth_maps.read(relative), media_type="image/png", headers={"Cache-Control": "no-store"})

    @app.put("/api/depth")
    async def put_depth(path: str, request: Request):
        relative = depth_maps.image_relative(path)
        content_type_header = request.headers.get("content-type", "")
        if content_type_header.split(";", 1)[0].strip().lower() != "image/png":
            raise HTTPException(415, "depth content type must be image/png")
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError as error:
                raise HTTPException(400, "invalid Content-Length") from error
            if declared_length < 0:
                raise HTTPException(400, "invalid Content-Length")
            if declared_length > MAX_DEPTH_MAP_BYTES:
                raise HTTPException(413, "depth body is too large")
        body = await _read_depth_body(request)
        return depth_maps.write(relative, body)

    @app.delete("/api/depth")
    def delete_depth(path: str):
        relative = depth_maps.image_relative(path)
        return depth_maps.delete(relative)

    @app.post("/api/depth/auto")
    def request_auto_depth(
        path: str,
        max_resolution: int = Query(default=512, ge=64, le=512),
    ):
        relative = _image_relative(root, path)
        return _no_store(auto_depth.request(relative, max_dimension=max_resolution))

    @app.get("/api/depth/auto")
    def auto_depth_status(path: str):
        relative = _image_relative(root, path)
        return _no_store(auto_depth.status(relative))

    @app.delete("/api/depth/auto")
    def cancel_auto_depth(path: str):
        relative = _image_relative(root, path)
        return _no_store(auto_depth.cancel(relative))

    @app.post("/api/adm/auto")
    def request_adm(
        path: str,
        max_resolution: int = Query(default=512, ge=64, le=512),
    ):
        relative = _image_relative(root, path)
        return _no_store(
            _adm_status(
                relative,
                request_missing=True,
                max_resolution=max_resolution,
            )
        )

    @app.get("/api/adm/auto")
    def adm_status(path: str):
        relative = _image_relative(root, path)
        return _no_store(_adm_status(relative, request_missing=False))

    @app.delete("/api/adm/auto")
    def cancel_adm(path: str):
        relative = _image_relative(root, path)
        mask = auto_masks.cancel(relative)
        depth = auto_depth.cancel(relative)
        return _no_store(_combined_adm_snapshot(relative, mask, depth))

    def _adm_status(
        relative: Path,
        *,
        request_missing: bool,
        max_resolution: int = 512,
    ) -> dict[str, object]:
        mask_info = masks.info(relative)
        depth_info = depth_maps.info(relative)
        mask_state = auto_masks.request(relative) if request_missing and not mask_info["exists"] else auto_masks.status(relative)
        depth_state = (
            auto_depth.request(relative, max_dimension=max_resolution)
            if request_missing and not depth_info["exists"]
            else auto_depth.status(relative)
        )
        return _combined_adm_snapshot(relative, mask_state, depth_state)

    def _combined_adm_snapshot(relative: Path, mask_state: dict[str, object], depth_state: dict[str, object]) -> dict[str, object]:
        statuses = [str(mask_state.get("status", "idle")), str(depth_state.get("status", "idle"))]
        if "failed" in statuses:
            status = "failed"
        elif "running" in statuses:
            status = "running"
        elif "queued" in statuses:
            status = "queued"
        elif "cancelled" in statuses:
            status = "cancelled"
        elif bool(mask_state.get("mask", {}).get("exists")) and bool(depth_state.get("depth", {}).get("exists")):
            status = "completed"
        else:
            status = "idle"
        return {
            "path": relative_text(relative),
            "status": status,
            "mask": mask_state,
            "depth": depth_state,
        }


async def _read_mask_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_MASK_BYTES:
            raise HTTPException(413, "mask body is too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def _read_depth_body(request: Request) -> bytes:
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_DEPTH_MAP_BYTES:
            raise HTTPException(413, "depth body is too large")
        chunks.append(chunk)
    return b"".join(chunks)


def _reject_internal_path(relative: Path) -> None:
    if is_internal_path(relative):
        raise HTTPException(404, "media path was not found")


def _media_relative(root: Path, path: str) -> Path:
    source, relative = resolve_under_root(root, path, directory=False)
    _reject_internal_path(relative)
    if media_type(source) is None:
        raise HTTPException(404, "unsupported media type")
    return source.relative_to(root)


def _image_relative(root: Path, path: str) -> Path:
    source, relative = resolve_under_root(root, path, directory=False)
    _reject_internal_path(relative)
    source_type = media_type(source)
    if source_type is None or not source_type.startswith("image/"):
        raise HTTPException(404, "unsupported media type")
    return source.relative_to(root)


def _commentary_relative(root: Path | None, path: str) -> tuple[Path, Path]:
    if root is None:
        raise HTTPException(404, "commentary is unavailable")
    return resolve_commentary_file(root, path)


async def _json_object(request: Request) -> dict:
    try:
        body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(422, "request body must be a JSON object") from None
    if not isinstance(body, dict):
        raise HTTPException(422, "request body must be a JSON object")
    return body


def _require_exact_keys(body: dict, expected: set[str]) -> None:
    if set(body) != expected:
        raise HTTPException(422, f"request body must contain only {', '.join(sorted(expected))}")


def _no_store(value: dict, *, status_code: int = 200) -> Response:
    return Response(
        content=json.dumps(value, ensure_ascii=False, separators=(",", ":")),
        status_code=status_code,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )


def json_response(value: dict[str, bool | int | str | None]) -> bytes:
    return json.dumps(value, separators=(",", ":")).encode("utf-8")
