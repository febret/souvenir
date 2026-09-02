from __future__ import annotations

from io import BytesIO
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import server.masks as masks_module
from server.application import create_app
from server.auto_mask import (
    AUTO_MASK_DEFAULT_BLUR,
    AUTO_MASK_INFERENCE_MAX_DIMENSION,
    _background_mask,
    _inference_image,
)
from server.depth_maps import MAX_DEPTH_MAP_BYTES
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
    if mode == "RGB":
        fill = color[:3]
    elif mode == "L":
        fill = color[0]
    else:
        fill = color
    image = Image.new(mode, size, fill)
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


class FakeAutoMaskGenerator:
    def __init__(
        self,
        *,
        payload: bytes | None = None,
        device: str = "cuda",
        started: threading.Event | None = None,
        release: threading.Event | None = None,
    ) -> None:
        self.payload = payload or _png_bytes((255, 255, 255, 255), size=(20, 10))
        self.device = device
        self.started = started
        self.release = release
        self.calls = 0
        self.max_dimensions: list[int] = []

    def generate(self, source: Path, *, max_dimension: int = 512) -> tuple[bytes, str]:
        self.calls += 1
        self.max_dimensions.append(max_dimension)
        if self.started is not None:
            self.started.set()
        if self.release is not None:
            self.release.wait(timeout=2)
        return self.payload, self.device

    def close(self) -> None:
        return None


class FakeAutoDepthGenerator:
    def __init__(
        self,
        *,
        payload: bytes | None = None,
        device: str = "cuda",
        started: threading.Event | None = None,
        release: threading.Event | None = None,
    ) -> None:
        self.payload = payload or _png_bytes(mode="L")
        self.device = device
        self.started = started
        self.release = release
        self.calls = 0
        self.max_dimensions: list[int] = []
        self.sources: list[Path] = []

    def generate(self, source: Path, *, max_dimension: int = 512) -> tuple[bytes, str]:
        self.calls += 1
        self.max_dimensions.append(max_dimension)
        self.sources.append(source)
        if self.started is not None:
            self.started.set()
        if self.release is not None:
            self.release.wait(timeout=2)
        return self.payload, self.device

    def close(self) -> None:
        return None


def test_auto_mask_scales_inference_image_to_max_dimension_preserving_aspect_ratio():
    landscape = _inference_image(
        Image.new("RGB", (1600, 900)),
        AUTO_MASK_INFERENCE_MAX_DIMENSION,
    )
    portrait = _inference_image(
        Image.new("RGB", (900, 1600)),
        AUTO_MASK_INFERENCE_MAX_DIMENSION,
    )
    small = _inference_image(
        Image.new("RGB", (320, 200)),
        AUTO_MASK_INFERENCE_MAX_DIMENSION,
    )

    assert landscape.width == AUTO_MASK_INFERENCE_MAX_DIMENSION
    assert landscape.height <= AUTO_MASK_INFERENCE_MAX_DIMENSION
    assert portrait.height == AUTO_MASK_INFERENCE_MAX_DIMENSION
    assert portrait.width <= AUTO_MASK_INFERENCE_MAX_DIMENSION
    assert landscape.width % 32 == 0 and landscape.height % 32 == 0
    assert portrait.width % 32 == 0 and portrait.height % 32 == 0
    assert small.size == (320, 192)


def test_auto_mask_upscales_probability_to_binary_background_mask():
    probability = Image.new("L", (512, 288), 0)
    probability.paste(255, (0, 0, 256, 288))

    background = _background_mask(
        probability,
        (1600, 900),
        threshold=0.48,
    )

    assert background.size == (1600, 900)
    assert background.getpixel((0, 450)) == 0
    assert background.getpixel((1599, 450)) == 255
    assert set(background.getdata()).issubset({0, 255})


def test_auto_mask_inference_dimensions_are_divisible_by_model_patch_size():
    image = _inference_image(
        Image.new("RGB", (400, 300)),
        AUTO_MASK_INFERENCE_MAX_DIMENSION,
    )

    assert image.width % 32 == 0
    assert image.height % 32 == 0
    assert image.width <= AUTO_MASK_INFERENCE_MAX_DIMENSION
    assert image.height <= AUTO_MASK_INFERENCE_MAX_DIMENSION


def test_generated_mask_storage_preserves_source_dimensions_above_manual_limit(library: Path):
    source = library / "albums" / "photo.jpg"
    Image.new("RGB", (2560, 1440), "red").save(source)
    store = masks_module.MaskStore(library)
    relative = Path("albums/photo.jpg")

    store.write_generated(
        relative,
        _png_bytes((255, 255, 255, 255), size=(2560, 1440)),
        blur=0,
    )

    with Image.open(BytesIO(store.read(relative))) as mask:
        assert mask.size == (2560, 1440)


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


def test_upload_images_writes_to_default_uploads_directory(client: TestClient, library: Path):
    response = client.post(
        "/api/uploads",
        files=[("files", ("new.jpg", _jpeg_bytes(), "image/jpeg"))],
    )

    assert response.status_code == 201
    body = response.json()
    assert body["directory"] == "uploads"
    assert [entry["path"] for entry in body["entries"]] == ["uploads/new.jpg"]
    assert (library / "uploads" / "new.jpg").is_file()
    listing = client.get("/api/media", params={"path": "uploads"})
    assert listing.status_code == 200
    assert any(entry["path"] == "uploads/new.jpg" for entry in listing.json()["files"])


def test_upload_images_supports_multi_file_submission(client: TestClient):
    response = client.post(
        "/api/uploads",
        files=[
            ("files", ("first.jpg", _jpeg_bytes((255, 0, 0)), "image/jpeg")),
            ("files", ("second.png", _png_bytes((0, 0, 255, 255)), "image/png")),
        ],
    )

    assert response.status_code == 201
    paths = [entry["path"] for entry in response.json()["entries"]]
    assert paths == ["uploads/first.jpg", "uploads/second.png"]


def test_upload_images_auto_renames_name_collisions(client: TestClient, library: Path):
    uploads = library / "uploads"
    uploads.mkdir()
    (uploads / "photo.jpg").write_bytes(_jpeg_bytes((12, 34, 56)))

    response = client.post(
        "/api/uploads",
        files=[("files", ("photo.jpg", _jpeg_bytes((1, 2, 3)), "image/jpeg"))],
    )

    assert response.status_code == 201
    assert response.json()["entries"][0]["path"] == "uploads/photo (2).jpg"
    assert (uploads / "photo (2).jpg").is_file()


def test_upload_images_reject_non_images(client: TestClient):
    response = client.post(
        "/api/uploads",
        files=[("files", ("notes.txt", b"not-an-image", "text/plain"))],
    )
    assert response.status_code == 415
    assert response.json()["detail"] == "upload content type must be image/*"


def test_upload_images_reject_invalid_image_payload(client: TestClient):
    response = client.post(
        "/api/uploads",
        files=[("files", ("fake.jpg", b"definitely-not-a-jpeg", "image/jpeg"))],
    )
    assert response.status_code == 415
    assert response.json()["detail"] == "unsupported uploaded image format"


def test_mask_save_get_and_restart_persistence(library: Path):
    source = Image.new("RGBA", (12, 8), (255, 255, 255, 0))
    source.paste((255, 255, 255, 255), (0, 0, 6, 8))
    output = BytesIO()
    source.save(output, format="PNG")
    payload = output.getvalue()
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
        fetched_binary = client.get("/api/mask", params={"path": "albums/photo.jpg", "variant": "binary"})
        assert fetched.status_code == 200
        assert fetched_binary.status_code == 200
        assert fetched.headers["content-type"].startswith("image/png")
        assert fetched.headers["cache-control"] == "no-store"
        assert fetched_binary.headers["cache-control"] == "no-store"
        with Image.open(BytesIO(fetched.content)) as mask:
            assert mask.mode == "RGBA"
            assert mask.size == (12, 8)
            alpha = set(mask.getchannel("A").getdata())
            assert any(0 < value < 255 for value in alpha)
        with Image.open(BytesIO(fetched_binary.content)) as mask_binary:
            assert mask_binary.mode == "RGBA"
            assert mask_binary.size == (12, 8)
            assert set(mask_binary.getchannel("A").getdata()).issubset({0, 255})

    with TestClient(create_app(library)) as restarted:
        info = restarted.get("/api/mask-info", params={"path": "albums/photo.jpg"})
        assert info.status_code == 200
        assert info.json() == body
        assert restarted.get("/api/mask", params={"path": "albums/photo.jpg"}).content == fetched.content
        assert restarted.get("/api/mask", params={"path": "albums/photo.jpg", "variant": "binary"}).content == fetched_binary.content


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


def test_auto_mask_queue_status_completion_and_device_reporting(library: Path):
    generator = FakeAutoMaskGenerator(
        payload=_png_bytes((255, 255, 255, 255), size=(20, 10)),
        device="cuda",
    )
    with TestClient(create_app(library, auto_mask_generator=generator)) as client:
        idle = client.get("/api/mask/auto", params={"path": "albums/photo.jpg"})
        assert idle.status_code == 200
        assert idle.json()["status"] == "idle"

        started = client.post("/api/mask/auto", params={"path": "albums/photo.jpg"})
        assert started.status_code == 200
        assert started.json()["status"] in {"queued", "running"}

        status = None
        for _ in range(40):
            status = client.get("/api/mask/auto", params={"path": "albums/photo.jpg"}).json()
            if status["status"] == "completed":
                break
            time.sleep(0.05)
        assert status is not None
        assert status["status"] == "completed"
        assert status["device"] == "cuda"
        assert status["mask"]["exists"] is True
        assert status["mask"]["blur"] == AUTO_MASK_DEFAULT_BLUR
        assert generator.calls == 1
        assert generator.max_dimensions == [512]
        assert client.get("/api/mask", params={"path": "albums/photo.jpg"}).status_code == 200


def test_depth_map_round_trip_and_size_validation(client: TestClient):
    path = {"path": "albums/photo.jpg"}
    png = _png_bytes(mode="L")
    saved = client.put(
        "/api/depth",
        params=path,
        content=png,
        headers={"Content-Type": "image/png"},
    )
    assert saved.status_code == 200
    assert saved.json()["exists"] is True
    assert client.get("/api/depth-info", params=path).json()["exists"] is True
    fetched = client.get("/api/depth", params=path)
    assert fetched.status_code == 200
    assert fetched.headers["content-type"] == "image/png"
    assert client.put(
        "/api/depth",
        params=path,
        content=png,
        headers={"Content-Type": "image/png", "Content-Length": str(MAX_DEPTH_MAP_BYTES + 1)},
    ).status_code == 413
    assert client.delete("/api/depth", params=path).status_code == 200
    assert client.get("/api/depth-info", params=path).json()["exists"] is False


def test_auto_depth_queue_status_completion_and_device_reporting(library: Path):
    generator = FakeAutoDepthGenerator(payload=_png_bytes(mode="L"), device="cuda")
    with TestClient(create_app(library, auto_depth_generator=generator)) as client:
        idle = client.get("/api/depth/auto", params={"path": "albums/photo.jpg"})
        assert idle.status_code == 200
        assert idle.json()["status"] == "idle"

        started = client.post("/api/depth/auto", params={"path": "albums/photo.jpg"})
        assert started.status_code == 200
        assert started.json()["status"] in {"queued", "running"}

        status = None
        for _ in range(40):
            status = client.get("/api/depth/auto", params={"path": "albums/photo.jpg"}).json()
            if status["status"] == "completed":
                break
            time.sleep(0.05)
        assert status is not None
        assert status["status"] == "completed"
        assert status["device"] == "cuda"
        assert status["depth"]["exists"] is True
        assert generator.calls == 1
        assert client.get("/api/depth", params={"path": "albums/photo.jpg"}).status_code == 200


def test_adm_generation_requests_only_missing_depth_artifacts(library: Path):
    mask_generator = FakeAutoMaskGenerator(
        payload=_png_bytes((255, 255, 255, 255), size=(20, 10)),
    )
    depth_generator = FakeAutoDepthGenerator(payload=_png_bytes(mode="L"))
    with TestClient(
        create_app(
            library,
            auto_mask_generator=mask_generator,
            auto_depth_generator=depth_generator,
        )
    ) as client:
        start = client.post("/api/adm/auto", params={"path": "albums/photo.jpg"})
        assert start.status_code == 200
        status = None
        for _ in range(40):
            status = client.get("/api/adm/auto", params={"path": "albums/photo.jpg"}).json()
            if status["status"] == "completed":
                break
            time.sleep(0.05)
        assert status is not None
        assert status["status"] == "completed"
        assert status["mask"]["status"] == "idle"
        assert status["mask"]["mask"]["exists"] is False
        assert mask_generator.calls == 0
        assert depth_generator.calls == 1
        assert depth_generator.sources == [library / "albums" / "photo.jpg"]


def test_media_adm_settings_persist_and_appear_in_listing(client: TestClient):
    saved = client.put(
        "/api/media-adm",
        params={"path": "albums/photo.jpg"},
        json={"enabled": True, "depth_intensity": 0.8},
    )
    assert saved.status_code == 200
    assert saved.json() == {
        "path": "albums/photo.jpg",
        "configured": True,
        "enabled": True,
        "depth_intensity": 0.8,
        "soft_depth_enabled": False,
        "soft_depth_blur": 12.0,
        "fade_depth_enabled": False,
        "fade_depth_start": 0.5,
        "focus_blur_enabled": False,
        "focus_position": "middle",
        "focus_strength": "middle",
        "light_fx_enabled": False,
        "light_direction": "front",
        "light_color": "white",
        "ambient_color": "white",
        "ambient_intensity": 0.5,
    }
    loaded = client.get("/api/media-adm", params={"path": "albums/photo.jpg"})
    assert loaded.status_code == 200
    assert loaded.json()["enabled"] is True
    listing = client.get("/api/media", params={"path": "albums"}).json()
    photo = next(entry for entry in listing["files"] if entry["path"] == "albums/photo.jpg")
    assert photo["adm"]["configured"] is True
    assert photo["adm"]["enabled"] is True
    assert photo["adm"]["depth_intensity"] == 0.8
    assert photo["adm"]["light_fx_enabled"] is False
    assert photo["adm"]["light_direction"] == "front"

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
