from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import logging
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server.application as application
import server.masks as masks_module
from server.application import create_app
from server.library import LibraryScanProgress, scan_media_library
from server.masks import MAX_MASK_BYTES


@pytest.fixture
def library(tmp_path: Path) -> Path:
    (tmp_path / "albums" / "trip").mkdir(parents=True)
    (tmp_path / "other").mkdir()
    Image.new("RGB", (20, 10), "red").save(tmp_path / "albums" / "photo.jpg")
    Image.new("RGB", (20, 10), "blue").save(tmp_path / "albums" / "trip" / "nested.png")
    (tmp_path / "albums" / "movie.mp4").write_bytes(b"0123456789")
    (tmp_path / "albums" / "ignore.txt").write_text("not media")
    return tmp_path


@pytest.fixture
def client(library: Path) -> TestClient:
    return TestClient(create_app(library))


def _png_bytes(
    color: tuple[int, int, int, int] = (255, 0, 0, 128),
    *,
    size: tuple[int, int] = (12, 8),
    mode: str = "RGBA",
) -> bytes:
    image = Image.new(mode, size, color[:3] if mode == "RGB" else color)
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def test_health_and_directory_listing(client: TestClient):
    health = client.get("/api/health").json()
    assert health["status"] == "ok"
    assert health["media_home"] == str(client.app.state.media_home)
    assert health["library_id"] == client.app.state.library_id
    assert health["library_id"].startswith("root-v1:")
    response = client.get("/api/media", params={"path": "albums"})
    assert response.status_code == 200
    body = response.json()
    assert [entry["name"] for entry in body["entries"]] == ["trip", "movie.mp4", "photo.jpg"]
    photo = body["files"][1]
    assert photo["kind"] == "file"
    assert photo["media_type"] == "image/jpeg"
    assert photo["url"] == "/api/file?path=albums/photo.jpg"
    assert photo["thumbnail_url"] == "/api/thumbnail?path=albums/photo.jpg"
    assert photo["size"] > 0 and photo["mtime"]


def test_library_status_is_initial_before_lifespan(library: Path):
    app = create_app(library)
    client = TestClient(app)
    status = client.get("/api/library-status").json()
    client.close()

    assert status == {
        "status": "scanning",
        "scanned_files": 0,
        "media_files": 0,
        "directories": 0,
        "current_path": "",
        "message": "Waiting for library scan to start",
        "started_at": None,
        "completed_at": None,
        "library_id": app.state.library_id,
    }


def test_library_status_is_visible_during_scan_and_ready_afterwards(library: Path):
    scanner_started = threading.Event()
    allow_completion = threading.Event()

    def blocking_scanner(root: Path, progress) -> None:
        progress.record_directory("albums")
        scanner_started.set()
        allow_completion.wait()
        progress.record_file("albums/photo.jpg", is_media_file=True)

    app = create_app(library, library_scanner=blocking_scanner)
    with TestClient(app) as client:
        assert scanner_started.wait(1)
        scanning = client.get("/api/library-status").json()
        assert scanning["status"] == "scanning"
        assert scanning["directories"] == 1
        assert scanning["started_at"] is not None
        assert scanning["completed_at"] is None

        allow_completion.set()
        assert app.state.library_scan.wait(1)
        ready = client.get("/api/library-status").json()

    assert ready["status"] == "ready"
    assert ready["scanned_files"] == ready["media_files"] == 1
    assert ready["completed_at"] is not None


def test_library_status_reports_scanner_errors(library: Path):
    def failing_scanner(root: Path, progress) -> None:
        raise RuntimeError("disk unavailable")

    app = create_app(library, library_scanner=failing_scanner)
    with TestClient(app) as client:
        assert app.state.library_scan.wait(1)
        status = client.get("/api/library-status").json()

    assert status["status"] == "error"
    assert status["message"] == "Library scan failed: disk unavailable"
    assert status["completed_at"] is not None


def test_library_scan_logs_progress_and_counts_media(library: Path, caplog):
    app = create_app(
        library,
        library_scanner=lambda root, progress: scan_media_library(root, progress, log_every_files=1),
    )
    caplog.set_level(logging.INFO, logger="server.library")
    with TestClient(app):
        assert app.state.library_scan.wait(1)

    status = app.state.library_scan.progress.snapshot()
    messages = [record.getMessage() for record in caplog.records if record.name == "server.library"]
    assert status["status"] == "ready"
    assert status["scanned_files"] == 4
    assert status["media_files"] == 3
    assert status["directories"] == 3
    assert any(message.startswith("Starting media library scan:") for message in messages)
    assert any(message.startswith("Media library scan progress:") for message in messages)
    assert any(message.startswith("Media library scan complete in") for message in messages)


def test_tree_and_clean_include_filtering(client: TestClient):
    tree = client.get("/api/tree", params=[("include", "albums/trip")]).json()
    assert tree["children"][0]["path"] == "albums"
    assert tree["children"][0]["children"][0]["path"] == "albums/trip"
    listing = client.get("/api/media", params=[("path", "albums"), ("include", "albums/trip")])
    assert [entry["name"] for entry in listing.json()["entries"]] == ["trip"]
    assert client.get("/api/media", params=[("path", "other"), ("include", "albums/trip")]).status_code == 200


@pytest.mark.parametrize("path", ["../secret", "albums/../../secret", "C:\\Windows", "/etc/passwd"])
def test_traversal_is_rejected(client: TestClient, path: str):
    assert client.get("/api/media", params={"path": path}).status_code in (400, 404)


def test_symlink_escape_is_not_served(client: TestClient, library: Path, tmp_path: Path):
    outside = tmp_path / "outside.jpg"
    Image.new("RGB", (5, 5)).save(outside)
    link = library / "albums" / "escape.jpg"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    assert client.get("/api/file", params={"path": "albums/escape.jpg"}).status_code == 404
    names = [item["name"] for item in client.get("/api/media", params={"path": "albums"}).json()["entries"]]
    assert "escape.jpg" not in names


def test_media_response_and_ranges(client: TestClient):
    full = client.get("/api/file", params={"path": "albums/movie.mp4"})
    assert full.status_code == 200
    assert full.headers["content-type"].startswith("video/mp4")
    assert full.headers["accept-ranges"] == "bytes"
    assert full.content == b"0123456789"
    partial = client.get("/api/file", params={"path": "albums/movie.mp4"}, headers={"Range": "bytes=2-5"})
    assert partial.status_code == 206
    assert partial.headers["content-range"] == "bytes 2-5/10"
    assert partial.content == b"2345"
    suffix = client.get("/api/file", params={"path": "albums/movie.mp4"}, headers={"Range": "bytes=-3"})
    assert suffix.status_code == 206 and suffix.content == b"789"
    invalid = client.get("/api/file", params={"path": "albums/movie.mp4"}, headers={"Range": "bytes=30-40"})
    assert invalid.status_code == 416
    assert invalid.headers["content-range"] == "bytes */10"


def test_image_and_video_thumbnails_are_cached(client: TestClient, library: Path):
    image = client.get("/api/thumbnail", params={"path": "albums/photo.jpg"})
    video = client.get("/api/thumbnail", params={"path": "albums/movie.mp4"})
    assert image.status_code == video.status_code == 200
    assert image.headers["content-type"].startswith("image/jpeg")
    assert image.content[:2] == video.content[:2] == b"\xff\xd8"
    cache_files = list((library / ".souvenir-thumbnails").glob("*.jpg"))
    assert len(cache_files) == 2
    assert client.get("/api/thumbnail", params={"path": "albums/photo.jpg"}).content == image.content


def test_static_spa_fallback_when_client_is_present(tmp_path: Path, monkeypatch):
    package = tmp_path / "server"
    package.mkdir()
    (package / "application.py").write_text("")
    app_dir = tmp_path / "app"
    app_dir.mkdir()
    (app_dir / "index.html").write_text("<h1>Souvenir</h1>")
    monkeypatch.setattr(application, "__file__", str(package / "application.py"))
    client = TestClient(application.create_app(tmp_path))
    assert client.get("/").text == "<h1>Souvenir</h1>"
    assert client.get("/xr/scene").text == "<h1>Souvenir</h1>"


def test_mask_info_is_absent_and_mask_get_is_not_found(client: TestClient):
    info = client.get("/api/mask-info", params={"path": "albums/photo.jpg"})

    assert info.status_code == 200
    assert info.headers["cache-control"] == "no-store"
    assert info.json() == {
        "exists": False,
        "path": "albums/photo.jpg",
        "blur": 0,
        "updated_at": None,
        "url": None,
    }
    assert client.get("/api/mask", params={"path": "albums/photo.jpg"}).status_code == 404


def test_mask_save_get_and_restart_persistence(library: Path):
    payload = _png_bytes()
    with TestClient(create_app(library)) as client:
        saved = client.put(
            "/api/mask",
            params={"path": "albums/photo.jpg", "blur": 12},
            content=payload,
            headers={"Content-Type": "image/png"},
        )
        assert saved.status_code == 200
        body = saved.json()
        assert body["exists"] is True
        assert body["path"] == "albums/photo.jpg"
        assert body["blur"] == 12
        assert body["updated_at"]
        assert body["url"] == "/api/mask?path=albums/photo.jpg"

        fetched = client.get("/api/mask", params={"path": "albums/photo.jpg"})
        assert fetched.status_code == 200
        assert fetched.headers["content-type"].startswith("image/png")
        assert fetched.headers["cache-control"] == "no-store"
        with Image.open(BytesIO(fetched.content)) as mask:
            assert mask.mode == "RGBA"
            assert mask.size == (12, 8)

    with TestClient(create_app(library)) as restarted:
        info = restarted.get("/api/mask-info", params={"path": "albums/photo.jpg"})
        assert info.status_code == 200
        assert info.json() == body
        assert restarted.get("/api/mask", params={"path": "albums/photo.jpg"}).content == fetched.content


def test_mask_overwrite_and_delete_are_idempotent(client: TestClient):
    first = _png_bytes((255, 0, 0, 255))
    second = _png_bytes((0, 0, 255, 255))
    assert client.put(
        "/api/mask",
        params={"path": "albums/photo.jpg", "blur": 1},
        content=first,
        headers={"Content-Type": "image/png"},
    ).status_code == 200
    saved = client.put(
        "/api/mask",
        params={"path": "albums/photo.jpg", "blur": 64},
        content=second,
        headers={"Content-Type": "image/png"},
    )
    assert saved.status_code == 200
    assert saved.json()["blur"] == 64

    with Image.open(BytesIO(client.get("/api/mask", params={"path": "albums/photo.jpg"}).content)) as mask:
        assert mask.convert("RGBA").getpixel((0, 0)) == (0, 0, 255, 255)

    deleted = client.delete("/api/mask", params={"path": "albums/photo.jpg"})
    assert deleted.status_code == 200
    assert deleted.json()["exists"] is False
    assert client.delete("/api/mask", params={"path": "albums/photo.jpg"}).json()["exists"] is False


@pytest.mark.parametrize("path", ["albums/ignore.txt", "../albums/photo.jpg", "albums/../../photo.jpg"])
def test_mask_rejects_unsupported_and_traversal_paths(client: TestClient, path: str):
    response = client.put(
        "/api/mask",
        params={"path": path},
        content=_png_bytes(),
        headers={"Content-Type": "image/png"},
    )
    assert response.status_code in (400, 404)


def test_mask_put_validates_content_type_size_png_and_dimensions(client: TestClient):
    path = {"path": "albums/photo.jpg"}
    png = _png_bytes()

    assert client.put("/api/mask", params=path, content=png).status_code == 415
    assert client.put(
        "/api/mask",
        params=path,
        content=png,
        headers={"Content-Type": "image/jpeg"},
    ).status_code == 415
    assert client.put(
        "/api/mask",
        params=path,
        content=b"not a png",
        headers={"Content-Type": "image/png"},
    ).status_code == 422
    assert client.put(
        "/api/mask",
        params=path,
        content=_png_bytes(size=(2049, 1)),
        headers={"Content-Type": "image/png"},
    ).status_code == 422
    assert client.put(
        "/api/mask",
        params=path,
        content=png,
        headers={"Content-Type": "image/png", "Content-Length": str(MAX_MASK_BYTES + 1)},
    ).status_code == 413
    assert client.put(
        "/api/mask",
        params=path,
        content=b"x" * (MAX_MASK_BYTES + 1),
        headers={"Content-Type": "image/png"},
    ).status_code == 413


def test_mask_storage_inconsistency_is_an_explicit_server_error(client: TestClient, library: Path):
    saved = client.put(
        "/api/mask",
        params={"path": "albums/photo.jpg"},
        content=_png_bytes(),
        headers={"Content-Type": "image/png"},
    )
    assert saved.status_code == 200
    metadata_path = next((library / ".souvenir-masks").glob("*.json"))
    metadata_path.write_text("{not json")

    response = client.get("/api/mask-info", params={"path": "albums/photo.jpg"})
    assert response.status_code == 500
    assert response.json()["detail"] == "mask metadata is malformed"

    mask_path = next((library / ".souvenir-masks").glob("*.png"))
    mask_path.unlink()
    assert client.get("/api/mask-info", params={"path": "albums/photo.jpg"}).status_code == 500


def test_mask_writes_remain_consistent_during_concurrent_requests(client: TestClient, library: Path):
    options = [
        (_png_bytes((255, 0, 0, 255)), 3),
        (_png_bytes((0, 255, 0, 255)), 20),
        (_png_bytes((0, 0, 255, 255)), 48),
    ]

    def save(option: tuple[bytes, int]) -> int:
        data, blur = option
        return client.put(
            "/api/mask",
            params={"path": "albums/photo.jpg", "blur": blur},
            content=data,
            headers={"Content-Type": "image/png"},
        ).status_code

    with ThreadPoolExecutor(max_workers=len(options)) as executor:
        assert list(executor.map(save, options)) == [200, 200, 200]

    info = client.get("/api/mask-info", params={"path": "albums/photo.jpg"})
    raw = client.get("/api/mask", params={"path": "albums/photo.jpg"})
    assert info.status_code == raw.status_code == 200
    assert info.json()["blur"] in {blur for _, blur in options}
    assert not list((library / ".souvenir-masks").glob("*.tmp"))


def test_mask_directory_is_excluded_from_listing_tree_and_scan(client: TestClient, library: Path):
    masks = library / ".souvenir-masks"
    masks.mkdir()
    Image.new("RGB", (2, 2)).save(masks / "unrelated.png")

    root_entries = client.get("/api/media", params={"path": ""}).json()["entries"]
    tree = client.get("/api/tree").json()
    progress = LibraryScanProgress()
    scan_media_library(library, progress)

    assert ".souvenir-masks" not in [entry["name"] for entry in root_entries]
    assert ".souvenir-masks" not in [entry["name"] for entry in tree["children"]]
    assert progress.snapshot()["media_files"] == 3
    assert client.get("/api/media", params={"path": ".souvenir-masks"}).status_code == 404
    assert client.get(
        "/api/file",
        params={"path": ".souvenir-masks/unrelated.png"},
    ).status_code == 404
    assert client.get(
        "/api/thumbnail",
        params={"path": ".souvenir-masks/unrelated.png"},
    ).status_code == 404


def test_mask_overwrite_rolls_back_when_metadata_replace_fails(
    client: TestClient,
    monkeypatch,
):
    path = "albums/photo.jpg"
    original = _png_bytes((255, 0, 0, 255))
    replacement = _png_bytes((0, 0, 255, 255))
    assert client.put(
        "/api/mask",
        params={"path": path, "blur": 3},
        content=original,
        headers={"Content-Type": "image/png"},
    ).status_code == 200
    persisted_original = client.get("/api/mask", params={"path": path}).content
    real_replace = masks_module.os.replace
    failed = False

    def fail_metadata_replace(source, destination):
        nonlocal failed
        if not failed and Path(destination).suffix == ".json":
            failed = True
            raise OSError("simulated metadata failure")
        return real_replace(source, destination)

    monkeypatch.setattr(masks_module.os, "replace", fail_metadata_replace)
    response = client.put(
        "/api/mask",
        params={"path": path, "blur": 12},
        content=replacement,
        headers={"Content-Type": "image/png"},
    )

    assert response.status_code == 500
    assert client.get("/api/mask", params={"path": path}).content == persisted_original
    assert client.get("/api/mask-info", params={"path": path}).json()["blur"] == 3
