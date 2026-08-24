from __future__ import annotations

from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .media import IMAGE_SUFFIXES, cache_path, thumbnail_is_current

THUMBNAIL_SIZE = (480, 360)


def create_thumbnail(root: Path, source: Path, relative: Path) -> Path:
    target = cache_path(root, relative)
    if thumbnail_is_current(target, source):
        return target
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if source.suffix.lower() in IMAGE_SUFFIXES:
        _image_thumbnail(source, target)
    else:
        _video_placeholder(source.name, target)
    return target


def _image_thumbnail(source: Path, target: Path) -> None:
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode not in ("RGB", "L"):
            image = image.convert("RGB")
        image.thumbnail(THUMBNAIL_SIZE)
        image.save(target, "JPEG", quality=85, optimize=True)


def _video_placeholder(name: str, target: Path) -> None:
    image = Image.new("RGB", THUMBNAIL_SIZE, "#172033")
    draw = ImageDraw.Draw(image)
    width, height = THUMBNAIL_SIZE
    for y in range(height):
        blue = 50 + int(55 * y / height)
        draw.line((0, y, width, y), fill=(21, 31, blue))
    triangle = [(width // 2 - 38, height // 2 - 52), (width // 2 - 38, height // 2 + 52), (width // 2 + 56, height // 2)]
    draw.polygon(triangle, fill="#ffffff")
    label = name if len(name) <= 48 else f"{name[:45]}..."
    draw.text((24, height - 40), label, fill="#d8e5ff")
    draw.text((24, 24), "VIDEO", fill="#8fb7ff")
    image.save(target, "JPEG", quality=88, optimize=True)
