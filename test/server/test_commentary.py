from __future__ import annotations

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
