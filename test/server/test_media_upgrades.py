from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient
from PIL import Image

from server.application import create_app


def _make_library(tmp_path: Path) -> Path:
    (tmp_path / "albums").mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (16, 10), "red").save(tmp_path / "albums" / "a.jpg")
    Image.new("RGB", (16, 10), "green").save(tmp_path / "albums" / "b.jpg")
    (tmp_path / "albums" / "movie.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    return tmp_path


def _mp4_bytes() -> bytes:
    return b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 128


def _webm_bytes() -> bytes:
    return b"\x1a\x45\xdf\xa3" + b"\x00" * 128


def test_video_upload_accepts_mp4_and_webm(tmp_path: Path):
    client = TestClient(create_app(_make_library(tmp_path)))
    response = client.post(
        "/api/uploads",
        files=[
            ("files", ("clip.mp4", _mp4_bytes(), "video/mp4")),
            ("files", ("clip.webm", _webm_bytes(), "video/webm")),
        ],
    )
    assert response.status_code == 201
    paths = [entry["path"] for entry in response.json()["entries"]]
    assert any(path.endswith(".mp4") for path in paths)
    assert any(path.endswith(".webm") for path in paths)


def test_video_upload_rejects_bad_magic(tmp_path: Path):
    client = TestClient(create_app(_make_library(tmp_path)))
    response = client.post(
        "/api/uploads",
        files=[("files", ("fake.mp4", b"not-a-video", "video/mp4"))],
    )
    assert response.status_code == 415


def test_media_listing_pagination_contract(tmp_path: Path):
    client = TestClient(create_app(_make_library(tmp_path)))
    first = client.get("/api/media", params={"path": "albums", "limit": 2, "offset": 0})
    assert first.status_code == 200
    body = first.json()
    assert body["total"] == 3
    assert body["limit"] == 2
    assert body["offset"] == 0
    assert body["has_more"] is True
    assert len(body["entries"]) == 2
    second = client.get("/api/media", params={"path": "albums", "limit": 2, "offset": 2})
    assert second.json()["has_more"] is False
    assert len(second.json()["entries"]) == 1
    # Full default response stays backward compatible.
    full = client.get("/api/media", params={"path": "albums"})
    assert full.json()["total"] == 3
    assert len(full.json()["files"]) == 3


def test_thumbnail_poster_time_varies_cache_key(tmp_path: Path):
    library = _make_library(tmp_path)
    client = TestClient(create_app(library))
    first = client.get("/api/thumbnail", params={"path": "albums/movie.mp4", "poster_time": 1.0})
    second = client.get("/api/thumbnail", params={"path": "albums/movie.mp4", "poster_time": 5.0})
    assert first.status_code == second.status_code == 200
    assert "ETag" in first.headers
    cache_files = list((library / ".souvenir-thumbnails").glob("*.jpg"))
    assert len(cache_files) == 2


def test_etag_conditional_requests(tmp_path: Path):
    client = TestClient(create_app(_make_library(tmp_path)))
    for route, params in (
        ("/api/file", {"path": "albums/a.jpg"}),
        ("/api/thumbnail", {"path": "albums/a.jpg"}),
    ):
        response = client.get(route, params=params)
        assert response.status_code == 200
        etag = response.headers.get("ETag")
        assert etag
        if route == "/api/file":
            assert response.headers.get("Accept-Ranges") == "bytes"
        not_modified = client.get(route, params=params, headers={"If-None-Match": etag})
        assert not_modified.status_code == 304
    # Stale If-Range must fall back to a full 200 response, not a 206.
    ranged = client.get(
        "/api/file",
        params={"path": "albums/a.jpg"},
        headers={"Range": "bytes=0-10", "If-Range": '"stale"'},
    )
    assert ranged.status_code == 200


def test_delete_removes_poster_variants(tmp_path: Path):
    library = _make_library(tmp_path)
    client = TestClient(create_app(library))
    client.get("/api/thumbnail", params={"path": "albums/movie.mp4", "poster_time": 1.0})
    client.get("/api/thumbnail", params={"path": "albums/movie.mp4", "poster_time": 5.0})
    assert len(list((library / ".souvenir-thumbnails").glob("*.jpg"))) == 2
    response = client.delete("/api/media", params={"path": "albums/movie.mp4"})
    assert response.status_code == 200
    assert list((library / ".souvenir-thumbnails").glob("*.jpg")) == []
