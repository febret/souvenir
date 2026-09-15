from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.application import create_app
from server.auto_mask import AUTO_MASK_DEFAULT_BLUR
from server.library import LibraryScanProgress, scan_media_library
from server.trash import move_media


def _png_bytes(
    color: tuple[int, int, int, int] = (255, 0, 0, 128),
    *,
    size: tuple[int, int] = (12, 8),
) -> bytes:
    image = Image.new("RGBA", size, color)
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def _jpeg_bytes(
    color: tuple[int, int, int] = (255, 0, 0),
    *,
    size: tuple[int, int] = (12, 8),
) -> bytes:
    image = Image.new("RGB", size, color)
    output = BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


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


def _create_tag(client: TestClient, name: str) -> dict[str, str]:
    response = client.post("/api/tags", json={"name": name})
    assert response.status_code == 201
    return response.json()


def test_delete_media_moves_file_to_the_trashcan(client: TestClient, library: Path):
    response = client.delete("/api/media", params={"path": "albums/photo.jpg"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"path": "albums/photo.jpg", "trashed": True}
    assert not (library / "albums" / "photo.jpg").exists()
    assert (library / ".trashcan" / "albums" / "photo.jpg").is_file()


def test_delete_media_removes_source_from_listing_and_scan(client: TestClient, library: Path):
    listing_before = client.get("/api/media", params={"path": "albums"}).json()
    assert {entry["name"] for entry in listing_before["files"]} == {"movie.mp4", "photo.jpg"}

    assert client.delete("/api/media", params={"path": "albums/movie.mp4"}).status_code == 200

    listing_after = client.get("/api/media", params={"path": "albums"}).json()
    assert {entry["name"] for entry in listing_after["files"]} == {"photo.jpg"}
    tree = client.get("/api/tree").json()
    albums = next(child for child in tree["children"] if child["path"] == "albums")
    assert not any(entry["name"] == "movie.mp4" for entry in albums["children"])
    progress = LibraryScanProgress()
    scan_media_library(library, progress)
    assert progress.snapshot()["media_files"] == 2


def test_trashcan_directory_is_excluded_from_listing_tree_and_scan(client: TestClient, library: Path):
    trash = library / ".trashcan"
    (trash / "stash").mkdir(parents=True)
    Image.new("RGB", (2, 2)).save(trash / "stash" / "hidden.jpg")

    root_entries = client.get("/api/media", params={"path": ""}).json()["entries"]
    tree = client.get("/api/tree").json()
    progress = LibraryScanProgress()
    scan_media_library(library, progress)

    assert ".trashcan" not in [entry["name"] for entry in root_entries]
    assert ".trashcan" not in [entry["name"] for entry in tree["children"]]
    assert progress.snapshot()["media_files"] == 3
    assert client.get("/api/media", params={"path": ".trashcan"}).status_code == 404
    assert client.get(
        "/api/file",
        params={"path": ".trashcan/stash/hidden.jpg"},
    ).status_code == 404
    assert client.get(
        "/api/thumbnail",
        params={"path": ".trashcan/stash/hidden.jpg"},
    ).status_code == 404


@pytest.mark.parametrize(
    "path",
    [
        "../albums/photo.jpg",
        "albums/../../photo.jpg",
        "C:\\Windows\\photo.jpg",
        "/etc/passwd",
        "albums/ignore.txt",
    ],
)
def test_delete_media_rejects_traversal_non_media_and_internal_paths(client: TestClient, path: str):
    response = client.delete("/api/media", params={"path": path})
    assert response.status_code in (400, 404)


def test_delete_media_rejects_internal_directory_paths(client: TestClient, library: Path):
    masks = library / ".souvenir-masks"
    masks.mkdir()
    Image.new("RGB", (2, 2)).save(masks / "unrelated.png")

    assert client.delete("/api/media", params={"path": ".souvenir-masks/unrelated.png"}).status_code == 404
    assert client.delete("/api/media", params={"path": ".souvenir-tags.json"}).status_code == 404


def test_delete_media_purges_derived_state(client: TestClient, library: Path):
    tag = _create_tag(client, "Summer")
    assert client.put(
        "/api/media-tags",
        params={"path": "albums/photo.jpg"},
        json={"tag_ids": [tag["id"]]},
    ).status_code == 200
    assert client.put(
        "/api/media-adm",
        params={"path": "albums/photo.jpg"},
        json={"enabled": True, "depth_intensity": 0.8},
    ).status_code == 200
    mask = _png_bytes((255, 0, 0, 255))
    assert client.put(
        "/api/mask",
        params={"path": "albums/photo.jpg", "blur": AUTO_MASK_DEFAULT_BLUR},
        content=mask,
        headers={"Content-Type": "image/png"},
    ).status_code == 200
    depth = _png_bytes((0, 0, 255, 255))
    assert client.put(
        "/api/depth",
        params={"path": "albums/photo.jpg"},
        content=depth,
        headers={"Content-Type": "image/png"},
    ).status_code == 200
    assert client.get("/api/thumbnail", params={"path": "albums/photo.jpg"}).status_code == 200

    assert client.delete("/api/media", params={"path": "albums/photo.jpg"}).status_code == 200

    assert not list((library / ".souvenir-masks").glob("*.png"))
    assert not list((library / ".souvenir-depth").glob("*.png"))
    assert not list((library / ".souvenir-thumbnails").glob("*.jpg"))
    state = json.loads((library / ".souvenir-tags.json").read_text(encoding="utf-8"))
    assert state["media_assignments"] == {}
    assert state["media_adm_settings"] == {}
    assert (library / ".trashcan" / "albums" / "photo.jpg").is_file()

    Image.new("RGB", (10, 10), "green").save(library / "albums" / "photo.jpg")
    listing = client.get("/api/media", params={"path": "albums"}).json()
    photo = next(entry for entry in listing["files"] if entry["path"] == "albums/photo.jpg")
    assert photo["tag_ids"] == []
    assert client.get("/api/media-tags", params={"path": "albums/photo.jpg"}).json()["tag_ids"] == []
    assert client.get("/api/media-adm", params={"path": "albums/photo.jpg"}).json()["configured"] is False


def test_delete_media_trash_collisions_are_uniquified(client: TestClient, library: Path):
    trash_target = library / ".trashcan" / "albums" / "photo.jpg"
    trash_target.parent.mkdir(parents=True)
    trash_target.write_bytes(_jpeg_bytes((1, 2, 3)))

    assert client.delete("/api/media", params={"path": "albums/photo.jpg"}).status_code == 200
    assert trash_target.is_file()
    assert (library / ".trashcan" / "albums" / "photo (1).jpg").is_file()

    Image.new("RGB", (5, 5), "yellow").save(library / "albums" / "photo.jpg")
    assert client.delete("/api/media", params={"path": "albums/photo.jpg"}).status_code == 200
    assert (library / ".trashcan" / "albums" / "photo (2).jpg").is_file()

    original = _jpeg_bytes((1, 2, 3))
    assert trash_target.read_bytes() == original
    assert (library / ".trashcan" / "albums" / "photo (1).jpg").read_bytes() != original


def test_delete_media_persistence_across_restart(library: Path):
    with TestClient(create_app(library)) as client:
        assert client.delete("/api/media", params={"path": "albums/photo.jpg"}).status_code == 200
    with TestClient(create_app(library)) as restarted:
        listing = restarted.get("/api/media", params={"path": "albums"}).json()
        assert {entry["name"] for entry in listing["files"]} == {"movie.mp4"}
        assert restarted.get("/api/file", params={"path": "albums/photo.jpg"}).status_code == 404

    assert (library / ".trashcan" / "albums" / "photo.jpg").is_file()


def test_move_media_rejects_trash_directory_symlink_escape(library: Path, tmp_path: Path):
    outside = tmp_path / "outside"
    outside.mkdir()
    try:
        (library / ".trashcan").symlink_to(outside, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"symlinks unavailable: {error}")

    with pytest.raises(Exception) as excinfo:
        move_media(library, Path("albums/photo.jpg"))
    assert getattr(excinfo.value, "status_code", None) == 500
    assert (library / "albums" / "photo.jpg").is_file()
    assert not (outside / "albums").exists()


def test_move_media_lowers_missing_source_to_404(client: TestClient):
    assert client.delete("/api/media", params={"path": "albums/gone.jpg"}).status_code == 404