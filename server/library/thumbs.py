"""サムネイル生成。"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import Image

THUMB_SIZE = 512


def make_thumb(image_bytes: bytes, dest: Path, size: int = THUMB_SIZE) -> None:
    with Image.open(io.BytesIO(image_bytes)) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size))
        im.save(dest, "JPEG", quality=85)
