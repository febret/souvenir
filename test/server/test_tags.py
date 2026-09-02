from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.application import create_app
from server.library import LibraryScanProgress, scan_media_library


@pytest.fixture
def library(tmp_path: Path) -> Path:
    (tmp_path / "albums").mkdir()
    Image.new("RGB", (10, 10), "red").save(tmp_path / "albums" / "photo.jpg")
    (tmp_path / "albums" / "movie.mp4").write_bytes(b"video")
    return tmp_path


@pytest.fixture
def client(library: Path) -> TestClient:
    return TestClient(create_app(library))


def _create(client: TestClient, name: str) -> dict[str, str]:
    response = client.post("/api/tags", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_tag_crud_normalizes_names_and_persists_assignments(library: Path):
    with TestClient(create_app(library)) as client:
        first = _create(client, "  Summer  ")
        second = _create(client, "旅行")
        assert len(first["id"]) == 32
        assert first["id"] != second["id"]
        listed = client.get("/api/tags")
        assert listed.headers["cache-control"] == "no-store"
        assert listed.json()["tags"] == [{"id": first["id"], "name": "Summer"}, second]
        assert listed.json()["updated_at"]

        saved = client.put(
            "/api/media-tags",
            params={"path": "albums/photo.jpg"},
            json={"tag_ids": [second["id"], first["id"], second["id"]]},
        )
        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json() == {"path": "albums/photo.jpg", "tag_ids": [first["id"], second["id"]]}
        assert client.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json() == saved.json()

        renamed = client.patch(f"/api/tags/{first['id']}", json={"name": "Holiday"})
        assert renamed.status_code == 200
        assert renamed.json() == {"id": first["id"], "name": "Holiday"}
        assert client.delete(f"/api/tags/{second['id']}").status_code == 204
        assert client.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == [first["id"]]

    with TestClient(create_app(library)) as restarted:
        assert restarted.get("/api/tags").json()["tags"] == [{"id": first["id"], "name": "Holiday"}]
        assert restarted.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == [first["id"]]


@pytest.mark.parametrize(
    "name",
    ["", "   ", "x" * 41, "line\nbreak", "null\x00byte", 4, ["array"]],
)
def test_tag_name_validation_rejects_invalid_types_and_controls(client: TestClient, name: object):
    assert client.post("/api/tags", json={"name": name}).status_code == 422


def test_media_tag_validation_listing_metadata_and_safe_paths(client: TestClient):
    tag = _create(client, "Favorite")
    assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"tag_ids": [tag["id"]]}).status_code == 200

    listing = client.get("/api/media", params={"path": "albums"}).json()
    photo = next(entry for entry in listing["files"] if entry["name"] == "photo.jpg")
    movie = next(entry for entry in listing["files"] if entry["name"] == "movie.mp4")
    assert photo["tag_ids"] == [tag["id"]]
    assert movie["tag_ids"] == []
    assert all(entry["tag_ids"] == [] for entry in client.get("/api/media", params={"path": ""}).json()["directories"])

    assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"tag_ids": ["missing"]}).status_code == 422
    assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"tag_ids": "wrong"}).status_code == 422
    assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"other": []}).status_code == 422
    assert client.get("/api/media-tags", params={"path": "albums/ignore.txt"}).status_code == 404
    assert client.get("/api/media-tags", params={"path": "../albums/photo.jpg"}).status_code in (400, 404)
    assert client.put("/api/media-tags", params={"path": "../albums/photo.jpg"}, json={"tag_ids": []}).status_code in (400, 404)
    assert client.patch("/api/tags/not-a-tag", json={"name": "x"}).status_code == 404
    assert client.delete("/api/tags/not-a-tag").status_code == 404


def test_bulk_media_tag_replacement_updates_multiple_paths_as_full_replacements(library: Path):
    with TestClient(create_app(library)) as client:
        first = _create(client, "Summer")
        second = _create(client, "Favorite")
        assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"tag_ids": [first["id"]]}).status_code == 200
        assert client.put(
            "/api/media-tags",
            params={"path": "albums/movie.mp4"},
            json={"tag_ids": [first["id"], second["id"]]},
        ).status_code == 200

        saved = client.put("/api/media-tags/bulk", json={
            "assignments": [
                {"path": "albums/photo.jpg", "tag_ids": [second["id"]]},
                {"path": "albums/movie.mp4", "tag_ids": []},
            ],
        })

        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json() == {
            "assignments": [
                {"path": "albums/photo.jpg", "tag_ids": [second["id"]]},
                {"path": "albums/movie.mp4", "tag_ids": []},
            ],
        }
        assert client.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == [second["id"]]
        assert client.get("/api/media-tags", params={"path": "albums/movie.mp4"}).json()["tag_ids"] == []

    with TestClient(create_app(library)) as restarted:
        assert restarted.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == [second["id"]]
        assert restarted.get("/api/media-tags", params={"path": "albums/movie.mp4"}).json()["tag_ids"] == []


def test_bulk_media_tag_validation_rejects_invalid_bodies_duplicate_paths_unknown_tags_and_missing_media(
    client: TestClient,
):
    tag = _create(client, "Favorite")

    assert client.put("/api/media-tags/bulk", json=["not", "an", "object"]).status_code == 422
    assert client.put("/api/media-tags/bulk", json={"assignments": {}}).status_code == 422
    assert client.put("/api/media-tags/bulk", json={
        "assignments": [{"path": "albums/photo.jpg", "tag_ids": [tag["id"]], "extra": True}],
    }).status_code == 422
    assert client.put("/api/media-tags/bulk", json={
        "assignments": [
            {"path": "albums/photo.jpg", "tag_ids": []},
            {"path": "albums/photo.jpg", "tag_ids": [tag["id"]]},
        ],
    }).status_code == 422
    assert client.put("/api/media-tags/bulk", json={
        "assignments": [{"path": "albums/photo.jpg", "tag_ids": ["missing"]}],
    }).status_code == 422
    assert client.put("/api/media-tags/bulk", json={
        "assignments": [{"path": "albums/missing.jpg", "tag_ids": []}],
    }).status_code == 404


@pytest.mark.parametrize(
    ("path", "expected_status"),
    [("../albums/photo.jpg", 400), ("albums/ignore.txt", 404)],
)
def test_bulk_media_tag_validation_rejects_traversal_and_non_media_paths(
    client: TestClient,
    library: Path,
    path: str,
    expected_status: int,
):
    (library / "albums" / "ignore.txt").write_text("not media", encoding="utf-8")

    response = client.put("/api/media-tags/bulk", json={
        "assignments": [{"path": path, "tag_ids": []}],
    })

    assert response.status_code == expected_status


def test_bulk_media_tag_replacement_is_all_or_nothing_when_validation_fails(client: TestClient):
    first = _create(client, "Summer")
    second = _create(client, "Favorite")
    assert client.put("/api/media-tags", params={"path": "albums/photo.jpg"}, json={"tag_ids": [first["id"]]}).status_code == 200
    assert client.put("/api/media-tags", params={"path": "albums/movie.mp4"}, json={"tag_ids": [second["id"]]}).status_code == 200

    failed = client.put("/api/media-tags/bulk", json={
        "assignments": [
            {"path": "albums/photo.jpg", "tag_ids": [second["id"]]},
            {"path": "albums/movie.mp4", "tag_ids": ["missing"]},
        ],
    })

    assert failed.status_code == 422
    assert client.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == [first["id"]]
    assert client.get("/api/media-tags", params={"path": "albums/movie.mp4"}).json()["tag_ids"] == [second["id"]]


def test_malformed_tag_storage_is_explicit_server_error(client: TestClient, library: Path):
    tag_file = library / ".souvenir-tags.json"
    tag_file.write_text("{not json", encoding="utf-8")
    response = client.get("/api/tags")
    assert response.status_code == 500
    assert response.json()["detail"] == "tag storage is malformed"

    tag_file.write_text(json.dumps({"version": 1, "updated_at": None, "tags": [], "assignments": {"../bad": []}}))
    assert client.get("/api/tags").status_code == 500


def test_tag_storage_file_is_excluded_from_media_apis_listing_and_scan(client: TestClient, library: Path):
    _create(client, "Creates storage")
    root_entries = client.get("/api/media", params={"path": ""}).json()["entries"]
    progress = LibraryScanProgress()
    scan_media_library(library, progress)

    assert ".souvenir-tags.json" not in [entry["name"] for entry in root_entries]
    assert progress.snapshot()["scanned_files"] == 2
    assert client.get("/api/media", params={"path": ".souvenir-tags.json"}).status_code == 404
    assert client.get("/api/file", params={"path": ".souvenir-tags.json"}).status_code == 404
    assert client.get("/api/thumbnail", params={"path": ".souvenir-tags.json"}).status_code == 404
