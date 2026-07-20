"""BGM（音楽素材）のストレージ。

BGM は特定の画像に属さないライブラリ全体の素材なので、``.studio/bgm/`` に
ファイルとして保存する。シーケンスからファイル名で参照する。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from server.library import paths

AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}

_SAFE_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def bgm_dir() -> Path:
    d = paths.studio_dir() / "bgm"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_name(filename: str) -> str:
    name = _SAFE_NAME.sub("_", Path(filename).name).strip()
    return name or "bgm.mp3"


def list_bgm() -> list[dict[str, Any]]:
    result = []
    for p in sorted(bgm_dir().iterdir()):
        if p.is_file() and p.suffix.lower() in AUDIO_EXT:
            result.append({"name": p.name, "size": p.stat().st_size})
    return result


def add_bgm(data: bytes, filename: str) -> dict[str, Any]:
    ext = Path(filename).suffix.lower()
    if ext not in AUDIO_EXT:
        raise ValueError(f"未対応の音声形式です: {ext or '(不明)'}")
    base = _safe_name(filename)
    dest = bgm_dir() / base
    # 同名があれば連番を付ける
    if dest.exists():
        stem, suf = Path(base).stem, Path(base).suffix
        n = 2
        while (bgm_dir() / f"{stem}_{n}{suf}").exists():
            n += 1
        dest = bgm_dir() / f"{stem}_{n}{suf}"
    dest.write_bytes(data)
    return {"name": dest.name, "size": dest.stat().st_size}


def path_for(name: str) -> Path:
    name = Path(name).name  # パストラバーサル防止
    p = bgm_dir() / name
    if not p.is_file():
        raise FileNotFoundError(f"bgm not found: {name}")
    return p


def delete_bgm(name: str) -> None:
    path_for(name).unlink()
