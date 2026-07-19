"""ライブラリのパス解決とアイテム ID 生成。

フォルダ＝正のデータモデルにおける物理配置ルール:

- ライブラリルート: 設定 ``library_root``（相対ならプロジェクトルート基準）、
  既定は ``data/library``。環境変数 ``STUDIO_LIBRARY_ROOT`` が最優先（テスト用）。
- ``.studio/`` はアプリ用メタデータの予約領域（インデックス DB・シーケンス定義）。
- 画像アイテムは「``meta.json`` を含むフォルダ」。それ以外はユーザーフォルダ。
"""

from __future__ import annotations

import os
import re
import secrets
import time
from pathlib import Path

from server import settings

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_LIBRARY_DIR = BASE_DIR / "data" / "library"

STUDIO_DIR_NAME = ".studio"
META_NAME = "meta.json"
VIDEOS_DIR_NAME = "videos"

_ITEM_ID_RE = re.compile(r"^\d{8}-\d{6}-[0-9a-f]{6}$")


def get_library_root() -> Path:
    env = os.environ.get("STUDIO_LIBRARY_ROOT", "").strip()
    if env:
        root = Path(env).expanduser()
    else:
        raw = str(settings.load().get("library_root") or "").strip()
        if raw:
            root = Path(raw).expanduser()
            if not root.is_absolute():
                root = (BASE_DIR / root).resolve()
        else:
            root = DEFAULT_LIBRARY_DIR
    root.mkdir(parents=True, exist_ok=True)
    return root


def studio_dir() -> Path:
    d = get_library_root() / STUDIO_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def sequences_dir() -> Path:
    d = studio_dir() / "sequences"
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return studio_dir() / "index.sqlite3"


def new_item_id() -> str:
    return time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3)


def is_item_id(name: str) -> bool:
    return bool(_ITEM_ID_RE.match(name))


def is_item_dir(path: Path) -> bool:
    return (path / META_NAME).is_file()


def normalize_rel(rel: str) -> str:
    """フォルダ相対パスを正規化する（区切りは ``/``、ルートは ``""``）。"""
    rel = (rel or "").replace("\\", "/").strip("/")
    if not rel:
        return ""
    parts = []
    for part in rel.split("/"):
        part = part.strip()
        if not part or part == ".":
            continue
        if part == ".." or part == STUDIO_DIR_NAME or part.startswith("."):
            raise ValueError(f"invalid path segment: {part!r}")
        parts.append(part)
    return "/".join(parts)


def resolve_rel(rel: str) -> Path:
    """相対パスをライブラリルート配下の絶対パスに安全に解決する。"""
    root = get_library_root()
    norm = normalize_rel(rel)
    path = (root / norm).resolve() if norm else root.resolve()
    if path != root.resolve() and root.resolve() not in path.parents:
        raise ValueError(f"path escapes library root: {rel!r}")
    return path


_FOLDER_NAME_BAD = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def validate_folder_name(name: str) -> str:
    name = (name or "").strip()
    if not name or name.startswith(".") or _FOLDER_NAME_BAD.search(name):
        raise ValueError(f"invalid folder name: {name!r}")
    if name in (STUDIO_DIR_NAME, VIDEOS_DIR_NAME) or is_item_id(name):
        raise ValueError(f"reserved folder name: {name!r}")
    return name
