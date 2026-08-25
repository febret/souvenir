from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.application import create_app
from server.config import COMMENTARY_DIR_ENV, MEDIA_HOME_ENV, load_settings


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    media = tmp_path / "media"
    commentary = tmp_path / "commentary"
    media.mkdir()
    commentary.mkdir()
    return media, commentary


@pytest.fixture
def client(roots: tuple[Path, Path]) -> TestClient:
    media, commentary = roots
    return TestClient(create_app(media, commentary_home=commentary))


def test_commentary_configuration_is_optional_and_rejects_invalid_directory(monkeypatch, tmp_path: Path):
    monkeypatch.setenv(MEDIA_HOME_ENV, str(tmp_path))
    monkeypatch.delenv(COMMENTARY_DIR_ENV, raising=False)
    assert load_settings().commentary_dir is None

    missing = tmp_path / "missing-commentary"
    monkeypatch.setenv(COMMENTARY_DIR_ENV, str(missing))
    with pytest.raises(RuntimeError, match=COMMENTARY_DIR_ENV):
        load_settings()


def test_commentary_listing_recurses_filters_formats_and_hides_dot_entries(
    client: TestClient,
    roots: tuple[Path, Path],
):
    _, commentary = roots
    (commentary / "nested").mkdir()
    (commentary / ".private").mkdir()
    for name in ("z.wav", "a.MP3", "nested/b.ogg", "nested/c.opus", "nested/d.m4a", "nested/e.aac", "nested/f.webm"):
        path = commentary / name
        path.parent.mkdir(exist_ok=True)
        path.write_bytes(b"audio")
    (commentary / "notes.txt").write_text("not audio")
    (commentary / ".hidden.mp3").write_bytes(b"hidden")
    (commentary / ".private" / "secret.mp3").write_bytes(b"hidden")

    response = client.get("/api/commentary")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert body["available"] is True
    assert [entry["name"] for entry in body["entries"]] == ["a.MP3", "b.ogg", "c.opus", "d.m4a", "e.aac", "f.webm", "z.wav"]
    assert {entry["media_type"] for entry in body["entries"]} == {
        "audio/wav", "audio/mpeg", "audio/ogg", "audio/mp4", "audio/aac", "audio/webm",
    }
    first = body["entries"][0]
    assert set(first) == {
        "name", "path", "media_type", "size", "mtime", "url", "tag_ids", "caption",
        "volume",
    }
    assert first["caption"] == ""
    assert first["volume"] == 1.0
    assert first["path"] == "a.MP3"
    assert first["url"] == "/api/commentary/file?path=a.MP3"
    assert first["size"] == 5
    for hidden_path in (".hidden.mp3", ".private/secret.mp3"):
        assert client.get(
            "/api/commentary/file",
            params={"path": hidden_path},
        ).status_code == 404
        assert client.get(
            "/api/commentary-tags",
            params={"path": hidden_path},
        ).status_code == 404
        assert client.get(
            "/api/commentary-caption",
            params={"path": hidden_path},
        ).status_code == 404
        assert client.get(
            "/api/commentary-volume",
            params={"path": hidden_path},
        ).status_code == 404


def test_commentary_file_range_and_safe_paths(client: TestClient, roots: tuple[Path, Path], tmp_path: Path):
    _, commentary = roots
    (commentary / "clip.mp3").write_bytes(b"0123456789")
    outside = tmp_path / "outside.mp3"
    outside.write_bytes(b"secret")
    link = commentary / "escape.mp3"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is unavailable")

    full = client.get("/api/commentary/file", params={"path": "clip.mp3"})
    partial = client.get("/api/commentary/file", params={"path": "clip.mp3"}, headers={"Range": "bytes=2-5"})
    invalid = client.get("/api/commentary/file", params={"path": "clip.mp3"}, headers={"Range": "bytes=30-40"})
    head = client.head("/api/commentary/file", params={"path": "clip.mp3"})

    assert full.status_code == 200
    assert full.headers["content-type"].startswith("audio/mpeg")
    assert partial.status_code == 206 and partial.content == b"2345"
    assert partial.headers["content-range"] == "bytes 2-5/10"
    assert invalid.status_code == 416 and invalid.headers["content-range"] == "bytes */10"
    assert head.status_code == 200 and not head.content
    assert client.get("/api/commentary/file", params={"path": "../outside.mp3"}).status_code in (400, 404)
    assert client.get("/api/commentary/file", params={"path": "escape.mp3"}).status_code == 404
    rejected = client.get("/api/commentary/file", params={"path": "../outside.mp3"})
    assert str(commentary) not in rejected.text


def test_commentary_is_explicitly_unavailable(roots: tuple[Path, Path]):
    media, _ = roots
    client = TestClient(create_app(media))

    assert client.get("/api/commentary").json() == {"available": False, "entries": []}
    response = client.get("/api/commentary-tags", params={"path": "clip.mp3"})
    assert response.status_code == 404
    assert response.json()["detail"] == "commentary is unavailable"
    assert client.get("/api/commentary-caption", params={"path": "clip.mp3"}).status_code == 404
    assert client.get("/api/commentary-volume", params={"path": "clip.mp3"}).status_code == 404


def test_commentary_tags_share_definitions_without_media_path_collisions(roots: tuple[Path, Path]):
    media, commentary = roots
    (media / "same.webm").write_bytes(b"video")
    (commentary / "same.webm").write_bytes(b"audio")
    with TestClient(create_app(media, commentary_home=commentary)) as client:
        tag = client.post("/api/tags", json={"name": "Favorite"}).json()
        assert client.put("/api/media-tags", params={"path": "same.webm"}, json={"tag_ids": [tag["id"]]}).status_code == 200
        saved = client.put("/api/commentary-tags", params={"path": "same.webm"}, json={"tag_ids": [tag["id"]]})
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json() == {"path": "same.webm", "tag_ids": [tag["id"]]}
        assert client.patch(f"/api/tags/{tag['id']}", json={"name": "Renamed"}).status_code == 200

    with TestClient(create_app(media, commentary_home=commentary)) as restarted:
        assert restarted.get("/api/media-tags", params={"path": "same.webm"}).json()["tag_ids"] == [tag["id"]]
        assert restarted.get("/api/commentary-tags", params={"path": "same.webm"}).json()["tag_ids"] == [tag["id"]]
        assert restarted.delete(f"/api/tags/{tag['id']}").status_code == 204
        assert restarted.get("/api/media-tags", params={"path": "same.webm"}).json()["tag_ids"] == []
        assert restarted.get("/api/commentary-tags", params={"path": "same.webm"}).json()["tag_ids"] == []


def test_v1_tags_migrate_to_v5_and_malformed_v5_is_rejected(roots: tuple[Path, Path]):
    media, commentary = roots
    (media / "clip.mp4").write_bytes(b"video")
    tag_id = "a" * 32
    tag_file = media / ".souvenir-tags.json"
    tag_file.write_text(json.dumps({
        "version": 1,
        "updated_at": None,
        "tags": [{"id": tag_id, "name": "Existing"}],
        "assignments": {"clip.mp4": [tag_id]},
    }))
    with TestClient(create_app(media, commentary_home=commentary)) as client:
        assert client.get("/api/media-tags", params={"path": "clip.mp4"}).json()["tag_ids"] == [tag_id]
        assert client.patch(f"/api/tags/{tag_id}", json={"name": "Migrated"}).status_code == 200

    stored = json.loads(tag_file.read_text())
    assert stored["version"] == 5
    assert stored["media_assignments"] == {"clip.mp4": [tag_id]}
    assert stored["commentary_assignments"] == {}
    assert stored["commentary_captions"] == {}
    assert stored["commentary_volumes"] == {}
    assert stored["media_adm_settings"] == {}
    tag_file.write_text(json.dumps({
        "version": 5, "updated_at": None, "tags": [],
        "media_assignments": {"../bad": []}, "commentary_assignments": {},
        "commentary_captions": {}, "commentary_volumes": {},
        "media_adm_settings": {},
    }))
    assert TestClient(create_app(media, commentary_home=commentary)).get("/api/tags").status_code == 500


def test_commentary_captions_are_validated_persisted_and_listed(roots: tuple[Path, Path]):
    media, commentary = roots
    (commentary / "clip.mp3").write_bytes(b"audio")
    with TestClient(create_app(media, commentary_home=commentary)) as client:
        saved = client.put(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
            json={"caption": " First message##Second message "},
        )
        assert saved.status_code == 200
        assert saved.headers["cache-control"] == "no-store"
        assert saved.json() == {
            "path": "clip.mp3",
            "caption": "First message##Second message",
        }
        assert client.get(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
        ).json()["caption"] == "First message##Second message"
        assert client.get("/api/commentary").json()["entries"][0]["caption"] == (
            "First message##Second message"
        )
        volume = client.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": 0.45},
        )
        assert volume.status_code == 200
        assert volume.json() == {"path": "clip.mp3", "volume": 0.45}
        assert client.get(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
        ).json()["volume"] == 0.45
        assert client.get("/api/commentary").json()["entries"][0]["volume"] == 0.45
        boosted = client.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": 1.5},
        )
        assert boosted.status_code == 200
        assert boosted.json() == {"path": "clip.mp3", "volume": 1.5}
        assert client.get(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
        ).json()["volume"] == 1.5
        assert client.get("/api/commentary").json()["entries"][0]["volume"] == 1.5
        assert client.put(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
            json={"caption": "x" * 5001},
        ).status_code == 422
        assert client.put(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
            json={"caption": 1},
        ).status_code == 422
        assert client.put(
            "/api/commentary-caption",
            params={"path": "missing.mp3"},
            json={"caption": "Missing"},
        ).status_code == 404
        assert client.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": 4.1},
        ).status_code == 422
        assert client.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": True},
        ).status_code == 422

    with TestClient(create_app(media, commentary_home=commentary)) as restarted:
        assert restarted.get(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
        ).json()["caption"] == "First message##Second message"
        assert restarted.put(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
            json={"caption": ""},
        ).json()["caption"] == ""
        assert restarted.get("/api/commentary").json()["entries"][0]["caption"] == ""
        assert restarted.get(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
        ).json()["volume"] == 1.5
        assert restarted.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": 1},
        ).json()["volume"] == 1.0


def test_v2_tags_migrate_without_losing_assignments(roots: tuple[Path, Path]):
    media, commentary = roots
    (commentary / "clip.mp3").write_bytes(b"audio")
    tag_id = "b" * 32
    tag_file = media / ".souvenir-tags.json"
    tag_file.write_text(json.dumps({
        "version": 2,
        "updated_at": None,
        "tags": [{"id": tag_id, "name": "Existing"}],
        "media_assignments": {},
        "commentary_assignments": {"clip.mp3": [tag_id]},
    }))
    with TestClient(create_app(media, commentary_home=commentary)) as client:
        assert client.get("/api/commentary").json()["entries"][0]["tag_ids"] == [tag_id]
        assert client.put(
            "/api/commentary-caption",
            params={"path": "clip.mp3"},
            json={"caption": "Migrated"},
        ).status_code == 200

    stored = json.loads(tag_file.read_text())
    assert stored["version"] == 5
    assert stored["commentary_assignments"] == {"clip.mp3": [tag_id]}
    assert stored["commentary_captions"] == {"clip.mp3": "Migrated"}
    assert stored["commentary_volumes"] == {}
    assert stored["media_adm_settings"] == {}


def test_v3_caption_storage_migrates_without_losing_captions(roots: tuple[Path, Path]):
    media, commentary = roots
    (commentary / "clip.mp3").write_bytes(b"audio")
    tag_file = media / ".souvenir-tags.json"
    tag_file.write_text(json.dumps({
        "version": 3,
        "updated_at": None,
        "tags": [],
        "media_assignments": {},
        "commentary_assignments": {},
        "commentary_captions": {"clip.mp3": "Keep this caption"},
    }))
    with TestClient(create_app(media, commentary_home=commentary)) as client:
        assert client.put(
            "/api/commentary-volume",
            params={"path": "clip.mp3"},
            json={"volume": 0.6},
        ).status_code == 200

    stored = json.loads(tag_file.read_text())
    assert stored["version"] == 5
    assert stored["commentary_captions"] == {"clip.mp3": "Keep this caption"}
    assert stored["commentary_volumes"] == {"clip.mp3": 0.6}
    assert stored["media_adm_settings"] == {}


def test_commentary_assignments_remain_atomic_under_concurrent_updates(client: TestClient, roots: tuple[Path, Path]):
    _, commentary = roots
    (commentary / "clip.mp3").write_bytes(b"audio")
    tag_ids = [client.post("/api/tags", json={"name": f"tag {index}"}).json()["id"] for index in range(12)]

    def assign(tag_id: str) -> int:
        return client.put("/api/commentary-tags", params={"path": "clip.mp3"}, json={"tag_ids": [tag_id]}).status_code

    with ThreadPoolExecutor(max_workers=12) as executor:
        assert list(executor.map(assign, tag_ids)) == [200] * 12

    assert client.get("/api/commentary-tags", params={"path": "clip.mp3"}).status_code == 200
