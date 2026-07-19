"""ライブラリルート切替のスモークテスト。

settings.json は一時ファイルに差し替え、実際の設定を汚さない。
実行: python tests/test_library_root.py
"""

from __future__ import annotations

import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.pop("STUDIO_LIBRARY_ROOT", None)

from PIL import Image

from server import settings
from server.library import folders, index_db, items, paths
from server.routes.library import RootUpdate, get_root, set_root

TMP = Path(tempfile.mkdtemp(prefix="studio-root-test-"))
settings.SETTINGS_PATH = TMP / "settings.json"

ROOT_A = TMP / "lib-a"
ROOT_B = TMP / "ライブラリ B"  # 日本語・スペース入りパス


def make_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (5, 5, 5)).save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    # ルート A に切替
    res = set_root(RootUpdate(path=str(ROOT_A)))
    assert Path(res["root"]) == ROOT_A
    assert paths.get_library_root() == ROOT_A
    assert get_root()["configured"] == str(ROOT_A)

    # A にデータを作る
    folders.create_folder("", "x")
    meta = items.create_item("x", make_png(), prompt="in root A")
    assert (ROOT_A / "x" / meta["id"] / "image.png").is_file()
    assert len(index_db.list_items("", recursive=True)) == 1

    # ルート B（空）に切替 → インデックスは B の内容（0件）になる
    res = set_root(RootUpdate(path=str(ROOT_B)))
    assert Path(res["root"]) == ROOT_B and res["indexed"] == 0
    assert index_db.list_items("", recursive=True) == []
    assert (ROOT_B / ".studio" / "index.sqlite3").is_file()

    # A に戻す → 自動リインデックスで 1 件復元
    res = set_root(RootUpdate(path=str(ROOT_A)))
    assert res["indexed"] == 1
    assert index_db.list_items("x")[0]["id"] == meta["id"]

    # 相対パスは拒否
    try:
        set_root(RootUpdate(path="relative/path"))
        raise AssertionError("相対パスはエラーになるべき")
    except Exception as e:
        assert "絶対パス" in str(e)

    print("ALL OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)
