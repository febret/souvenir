from PIL import Image

from server.auto_depth import MAX_AUTO_DEPTH_DIMENSION, _prepare_depth_input


def test_depth_input_downscales_long_edge_to_512_without_changing_aspect_ratio():
    landscape = _prepare_depth_input(Image.new("RGB", (1600, 900)))
    portrait = _prepare_depth_input(Image.new("RGB", (900, 1600)))

    assert MAX_AUTO_DEPTH_DIMENSION == 512
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
