"""アイテムフォルダの meta.json 読み書き。

meta.json がフォルダを「画像アイテム」たらしめる正本データ。
書き込みは一時ファイル経由のアトミック置換で行い、途中クラッシュしても
壊れた meta.json が残らないようにする。
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from server.library.paths import META_NAME


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_meta(
    item_id: str,
    *,
    image_file: str,
    prompt: str = "",
    negative_prompt: str = "",
    seed: int | None = None,
    params: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    caption: str = "",
) -> dict[str, Any]:
    return {
        "id": item_id,
        "created_at": now_iso(),
        "image": image_file,
        "thumb": "thumb.jpg",
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "seed": seed,
        "params": params or {},
        "tags": tags or [],
        "caption": caption,
        # 並べ替え用。既定は作成時刻（新しいものほど大きい＝先頭）
        "sort_order": time.time(),
        "videos": [],
    }


def load_meta(item_dir: Path) -> dict[str, Any]:
    with (item_dir / META_NAME).open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError(f"broken meta.json in {item_dir}")
    return data


def save_meta(item_dir: Path, meta: dict[str, Any]) -> None:
    path = item_dir / META_NAME
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
