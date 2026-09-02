from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from server.application import create_app


@pytest.fixture
def library(tmp_path: Path) -> Path:
    (tmp_path / "albums").mkdir()
    Image.new("RGB", (10, 10), "red").save(tmp_path / "albums" / "photo.jpg")
    return tmp_path


@pytest.fixture
def client(library: Path) -> TestClient:
    return TestClient(create_app(library))


def test_scene_create_list_get_and_replace_persist(client: TestClient, library: Path):
    created = client.post("/api/scenes", json={"name": "  Family Night  "})
    assert created.status_code == 201
    scene = created.json()
    assert scene["name"] == "Family Night"
    assert scene["loop"] is True
    assert scene["default_duration_sec"] == 8
    assert scene["shots"] == []
    assert scene["current_shot_id"] is None

    listed = client.get("/api/scenes")
    assert listed.status_code == 200
    assert listed.headers["cache-control"] == "no-store"
    summaries = listed.json()["scenes"]
    assert len(summaries) == 1
    assert summaries[0]["id"] == scene["id"]
    assert summaries[0]["shot_count"] == 0

    payload = {
        "loop": False,
        "default_duration_sec": 6,
        "current_shot_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "shots": [
            {
                "id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "duration_sec": 6,
                "panels": [
                    {
                        "id": "panel-1",
                        "media": {
                            "directory": "albums",
                            "selectedId": "albums/photo.jpg",
                            "sort": "name",
                            "view": "thumbnails",
                        },
                        "transform": {
                            "position": {"x": 0, "y": 1.2, "z": -1.4},
                            "rotation": {"x": 0, "y": 0.2, "z": 0},
                        },
                        "dimensions": {"width": 1.2, "height": 0.8},
                    }
                ],
            }
        ],
    }
    replaced = client.put(f"/api/scenes/{scene['id']}", json=payload)
    assert replaced.status_code == 200
    assert replaced.headers["cache-control"] == "no-store"
    assert replaced.json()["loop"] is False
    assert replaced.json()["shots"][0]["panels"][0]["id"] == "panel-1"

    loaded = client.get(f"/api/scenes/{scene['id']}")
    assert loaded.status_code == 200
    assert loaded.json()["default_duration_sec"] == 6
    assert loaded.json()["current_shot_id"] == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

    with TestClient(create_app(library)) as restarted:
        persisted = restarted.get(f"/api/scenes/{scene['id']}")
        assert persisted.status_code == 200
        assert persisted.json()["shots"][0]["duration_sec"] == 6


@pytest.mark.parametrize(
    "body",
    [
        {"name": ""},
        {"name": "   "},
        {"name": "x" * 81},
        {"wrong": "field"},
    ],
)
def test_scene_create_validates_name(client: TestClient, body: dict):
    assert client.post("/api/scenes", json=body).status_code == 422


def test_scene_replace_validates_shape(client: TestClient):
    scene = client.post("/api/scenes", json={"name": "Trip"}).json()
    invalid = client.put(
        f"/api/scenes/{scene['id']}",
        json={"loop": True, "default_duration_sec": 0, "current_shot_id": None, "shots": []},
    )
    assert invalid.status_code == 422

    missing = client.get("/api/scenes/not-a-scene-id")
    assert missing.status_code == 404
