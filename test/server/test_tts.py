from __future__ import annotations

import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.application import create_app
from server.media import is_internal_path
from server.tts import MAX_TTS_TEXT_LENGTH, TTS_TUNING_MAX, TTS_WORK_DIRNAME


class FakeTtsGenerator:
    def __init__(
        self,
        *,
        payload: bytes = b"preview-audio",
        media_type: str = "audio/mpeg",
        error: Exception | None = None,
        release: threading.Event | None = None,
    ) -> None:
        self.payload = payload
        self.media_type = media_type
        self.error = error
        self.release = release
        self.calls = 0

    def synthesize(self, output: Path, *, text: str, voice: str, rate_percent: int, pitch_percent: int) -> str:
        self.calls += 1
        if self.error is not None:
            raise self.error
        if self.release is not None:
            self.release.wait(timeout=10)
        output.write_bytes(self.payload)
        return self.media_type

    def list_voices(self) -> list[dict[str, str]]:
        return [{"id": "en-US-Emma", "name": "Emma", "locale": "en-US", "gender": "Female"}]


@pytest.fixture
def roots(tmp_path: Path) -> tuple[Path, Path]:
    media = tmp_path / "media"
    commentary = tmp_path / "commentary"
    media.mkdir()
    commentary.mkdir()
    return media, commentary


def _wait_for_status(client: TestClient, request_id: str, terminal: set[str], *, attempts: int = 100) -> dict:
    snapshot: dict = {}
    for _ in range(attempts):
        snapshot = client.get(f"/api/commentary/tts/{request_id}").json()
        if snapshot["status"] in terminal:
            return snapshot
        time.sleep(0.02)
    raise AssertionError(f"TTS request did not reach {terminal}: {snapshot}")


def test_tts_request_validates_body(roots: tuple[Path, Path]):
    media, commentary = roots
    generator = FakeTtsGenerator()
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        assert client.post("/api/commentary/tts", json={"text": "hi"}).status_code == 422
        assert client.post(
            "/api/commentary/tts",
            json={"text": "   ", "voice": "v", "pitch": 0, "rate": 0},
        ).status_code == 422
        assert client.post(
            "/api/commentary/tts",
            json={"text": "x" * (MAX_TTS_TEXT_LENGTH + 1), "voice": "v", "pitch": 0, "rate": 0},
        ).status_code == 422
        assert client.post(
            "/api/commentary/tts",
            json={"text": "hi", "voice": "v", "pitch": 0, "rate": TTS_TUNING_MAX + 1},
        ).status_code == 422
        assert generator.calls == 0


def test_tts_lifecycle_streams_preview_and_isolates_files(roots: tuple[Path, Path]):
    media, commentary = roots
    generator = FakeTtsGenerator(payload=b"wave-data", media_type="audio/mpeg")
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        created = client.post(
            "/api/commentary/tts",
            json={"text": "Hello world", "voice": "en-US-Emma", "pitch": -20, "rate": 25},
        )
        assert created.status_code == 201
        body = created.json()
        assert body["status"] == "queued"

        snapshot = _wait_for_status(client, body["id"], {"completed"})
        assert snapshot["media_type"] == "audio/mpeg"
        assert snapshot["url"] == f"/api/commentary/tts/file?request_id={body['id']}"

        # Preview files stay hidden from commentary listing/file APIs.
        assert list((commentary / TTS_WORK_DIRNAME).iterdir())
        assert client.get("/api/commentary").json()["entries"] == []

        stream = client.get("/api/commentary/tts/file", params={"request_id": body["id"]})
        assert stream.status_code == 200
        assert stream.headers["accept-ranges"] == "bytes"
        assert stream.content == b"wave-data"

        ranged = client.get(
            "/api/commentary/tts/file",
            params={"request_id": body["id"]},
            headers={"Range": "bytes=4-7"},
        )
        assert ranged.status_code == 206
        assert ranged.content == b"-dat"


def test_tts_failure_and_cancel(roots: tuple[Path, Path]):
    media, commentary = roots
    release = threading.Event()
    generator = FakeTtsGenerator(release=release)
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        failing = FakeTtsGenerator(error=RuntimeError("network is down"))
        with TestClient(create_app(media, commentary_home=commentary, tts_generator=failing)) as failing_client:
            created = failing_client.post(
                "/api/commentary/tts", json={"text": "boom", "voice": "v", "pitch": 0, "rate": 0}
            ).json()
            snapshot = _wait_for_status(failing_client, created["id"], {"failed"})
            assert snapshot["error"] == "network is down"
            assert failing_client.get(
                "/api/commentary/tts/file", params={"request_id": created["id"]}
            ).status_code == 404

        first = client.post(
            "/api/commentary/tts", json={"text": "one", "voice": "v", "pitch": 0, "rate": 0}
        ).json()
        cancelled = client.delete(f"/api/commentary/tts/{first['id']}")
        assert cancelled.json()["status"] == "cancelled"
        assert client.get(
            "/api/commentary/tts/file", params={"request_id": first["id"]}
        ).status_code == 404
        assert client.get("/api/commentary/tts/not-a-request-id").status_code == 404
        release.set()


def test_commentary_save_uploads_lists_and_persists(roots: tuple[Path, Path]):
    media, commentary = roots
    generator = FakeTtsGenerator()
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        tag = client.post("/api/tags", json={"name": "Intro"}).json()
        saved = client.post(
            "/api/commentary",
            files=[("file", ("intro.wav", b"RIFFxxxxWAVE", "audio/wav"))],
            data={"tags": f'["{tag["id"]}"]'},
        )
        assert saved.status_code == 201
        entry = saved.json()
        assert entry["name"].endswith(".wav")
        assert entry["tag_ids"] == [tag["id"]]
        assert (commentary / entry["name"]).is_file()

        listed = client.get("/api/commentary").json()
        assert [item["name"] for item in listed["entries"]] == [entry["name"]]

    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as restarted:
        listed = restarted.get("/api/commentary").json()
        assert [item["name"] for item in listed["entries"]] == [entry["name"]]
        assert listed["entries"][0]["tag_ids"] == [tag["id"]]


def test_commentary_save_rejects_non_audio_and_tts_dir_is_internal(roots: tuple[Path, Path]):
    media, commentary = roots
    generator = FakeTtsGenerator()
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        assert client.post(
            "/api/commentary", files=[("file", ("a.txt", b"text", "text/plain"))]
        ).status_code == 415
        assert client.post(
            "/api/commentary", files=[("file", ("a.wav", b"not-audio-at-all", "audio/wav"))]
        ).status_code == 422

    assert is_internal_path(Path(TTS_WORK_DIRNAME) / "preview.mp3")
    work = media / TTS_WORK_DIRNAME
    work.mkdir()
    (work / "preview.mp3").write_bytes(b"ID3preview")
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        root_entries = client.get("/api/media", params={"path": ""}).json()["entries"]
        assert TTS_WORK_DIRNAME not in [entry["name"] for entry in root_entries]
        assert client.get("/api/file", params={"path": f"{TTS_WORK_DIRNAME}/preview.mp3"}).status_code == 404
        assert client.get(
            "/api/thumbnail", params={"path": f"{TTS_WORK_DIRNAME}/preview.mp3"}
        ).status_code == 404
        Image.new("RGB", (2, 2)).save(work / "cover.jpg")
        assert client.get("/api/file", params={"path": f"{TTS_WORK_DIRNAME}/cover.jpg"}).status_code == 404


def test_commentary_save_rejects_invalid_tags_without_leaving_a_file(roots: tuple[Path, Path]):
    media, commentary = roots
    generator = FakeTtsGenerator()
    with TestClient(create_app(media, commentary_home=commentary, tts_generator=generator)) as client:
        assert client.post(
            "/api/commentary",
            files=[("file", ("intro.wav", b"RIFFxxxxWAVE", "audio/wav"))],
            data={"tags": "not-json"},
        ).status_code == 422
        assert client.post(
            "/api/commentary",
            files=[("file", ("intro.wav", b"RIFFxxxxWAVE", "audio/wav"))],
            data={"tags": "[\"missing-tag-id\"]"},
        ).status_code == 422
        assert client.get("/api/commentary").json()["entries"] == []
        assert [child.name for child in commentary.iterdir()] == [TTS_WORK_DIRNAME]
