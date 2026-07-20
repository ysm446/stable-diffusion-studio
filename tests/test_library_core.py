"""ライブラリコアのスモークテスト。

一時フォルダをライブラリルートにして CRUD・検索・再構築を一通り実行する。
実行: python tests/test_library_core.py
"""

from __future__ import annotations

import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP_ROOT = Path(tempfile.mkdtemp(prefix="studio-library-test-"))
os.environ["STUDIO_LIBRARY_ROOT"] = str(TMP_ROOT)

from PIL import Image

from server.library import folders, index_db, items, paths


def make_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 100, 50)).save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    # フォルダ作成（入れ子）
    assert folders.create_folder("", "風景") == "風景"
    assert folders.create_folder("風景", "海") == "風景/海"
    assert folders.create_folder("", "キャラ") == "キャラ"

    # アイテム作成
    meta = items.create_item(
        "風景/海",
        make_png(),
        prompt="ocean sunset, golden hour",
        negative_prompt="blurry",
        seed=42,
        params={"steps": 28},
        tags=["sea"],
    )
    item_id = meta["id"]
    item_dir = paths.resolve_rel("風景/海") / item_id
    assert (item_dir / "image.png").is_file()
    assert (item_dir / "thumb.jpg").is_file()
    assert (item_dir / "meta.json").is_file()

    # 一覧・検索
    assert len(index_db.list_items("風景/海")) == 1
    assert len(index_db.list_items("風景", recursive=True)) == 1
    assert len(index_db.list_items("キャラ")) == 0
    hits = index_db.search_items("sunset")
    assert len(hits) == 1 and hits[0]["id"] == item_id
    assert index_db.search_items("nonexistent") == []

    # 動画の追加・削除
    meta = items.add_video(item_id, b"fake-mp4-bytes", prompt="waves rolling")
    assert meta["videos"][0]["file"] == "videos/v001.mp4"
    assert (item_dir / "videos" / "v001.mp4").is_file()
    meta = items.add_video(item_id, b"fake-mp4-bytes-2")
    assert meta["videos"][1]["file"] == "videos/v002.mp4"
    assert index_db.get_item_row(item_id)["video_count"] == 2
    meta = items.remove_video(item_id, "v001.mp4")
    assert [v["file"] for v in meta["videos"]] == ["videos/v002.mp4"]
    assert not (item_dir / "videos" / "v001.mp4").exists()

    # アイテム更新・移動
    meta = items.update_item(item_id, {"tags": ["sea", "favorite"], "caption": "夕暮れの海"})
    assert index_db.search_items("favorite")[0]["id"] == item_id
    meta = items.move_item(item_id, "キャラ")
    assert meta["folder"] == "キャラ"
    assert len(index_db.list_items("風景/海")) == 0
    assert len(index_db.list_items("キャラ")) == 1

    # フォルダのリネーム・移動
    assert folders.rename_folder("キャラ", "お気に入り") == "お気に入り"
    assert index_db.get_item_row(item_id)["folder"] == "お気に入り"
    assert folders.move_folder("お気に入り", "風景") == "風景/お気に入り"
    assert index_db.get_item_row(item_id)["folder"] == "風景/お気に入り"

    # インデックス再構築（DB を消しても復元できる）
    paths.db_path().unlink()
    count = index_db.rebuild()
    assert count == 1
    row = index_db.get_item_row(item_id)
    assert row["folder"] == "風景/お気に入り" and row["video_count"] == 1
    assert index_db.search_items("favorite")[0]["id"] == item_id

    # 取り込み（メタデータなし PNG）
    imported = items.import_image("風景", make_png(), "photo.png")
    assert index_db.get_item_row(imported["id"]) is not None

    # 取り込み（A1111 メタデータ付き PNG → プロパティが復元される）
    from PIL.PngImagePlugin import PngInfo

    pnginfo = PngInfo()
    pnginfo.add_text(
        "parameters",
        "cute cat, sunshine\n"
        "Negative prompt: blurry, lowres\n"
        "Steps: 28, Sampler: Euler a, CFG scale: 7, Seed: 1234, Size: 64x64",
    )
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (1, 2, 3)).save(buf, "PNG", pnginfo=pnginfo)
    imported2 = items.import_image("風景", buf.getvalue(), "a1111.png")
    assert imported2["prompt"] == "cute cat, sunshine"
    assert imported2["negative_prompt"] == "blurry, lowres"
    assert imported2["seed"] == 1234
    assert imported2["params"]["steps"] == 28
    assert imported2["params"]["sampler"] == "Euler a"
    assert imported2["params"]["width"] == 64
    assert index_db.search_items("sunshine")[0]["id"] == imported2["id"]

    # 削除
    items.delete_item(item_id)
    assert index_db.get_item_row(item_id) is None
    ok = False
    try:
        items.item_dir(item_id)
    except items.NotFound:
        ok = True
    assert ok

    # 空でないフォルダは recursive なしでは消せない
    ok = False
    try:
        folders.delete_folder("風景")
    except folders.FolderError:
        ok = True
    assert ok
    folders.delete_folder("風景", recursive=True)
    assert len(index_db.list_items("", recursive=True)) == 0

    # パストラバーサル拒否
    for bad in ("../x", "..", ".studio", ".hidden"):
        ok = False
        try:
            paths.normalize_rel(bad)
        except ValueError:
            ok = True
        assert ok, bad

    print("ALL OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
