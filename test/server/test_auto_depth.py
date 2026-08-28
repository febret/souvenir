from PIL import Image

from server.auto_depth import (
    DEFAULT_AUTO_DEPTH_DIMENSION,
    MAX_AUTO_DEPTH_DIMENSION,
    _prepare_depth_input,
)


def test_depth_input_downscales_long_edge_to_max_dimension_without_changing_aspect_ratio():
    landscape = _prepare_depth_input(Image.new("RGB", (6400, 3600)))
    portrait = _prepare_depth_input(Image.new("RGB", (3600, 6400)))

    assert DEFAULT_AUTO_DEPTH_DIMENSION == 512
    assert MAX_AUTO_DEPTH_DIMENSION == 2048
    assert landscape.size == (512, 288)
    assert portrait.size == (288, 512)


def test_depth_input_does_not_upscale_small_images():
    source = Image.new("RGB", (320, 240))

    prepared = _prepare_depth_input(source)

    assert prepared is source
    assert prepared.size == (320, 240)


def test_depth_input_uses_requested_maximum_dimension():
    prepared = _prepare_depth_input(
        Image.new("RGB", (1600, 900)),
        max_dimension=192,
    )

    assert prepared.size == (192, 108)


def test_depth_input_supports_explicit_larger_requested_dimension():
    prepared = _prepare_depth_input(
        Image.new("RGB", (6400, 3600)),
        max_dimension=MAX_AUTO_DEPTH_DIMENSION,
    )

    assert prepared.size == (2048, 1152)
