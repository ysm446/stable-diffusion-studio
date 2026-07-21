"""生成サービスのスモークテスト（バックエンドはモック）。

Forge / ComfyUI を起動せずに、生成結果がライブラリへ正しく保存されることを確認する。
実行: python tests/test_generation_service.py
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP_ROOT = Path(tempfile.mkdtemp(prefix="studio-gen-test-"))
os.environ["STUDIO_LIBRARY_ROOT"] = str(TMP_ROOT)

from PIL import Image

from server.generation import comfy_client, comfy_process, forge_client, sd_process, service
from server.library import folders, index_db, items


def main() -> None:
    folders.create_folder("", "gen")
    statuses: list[str] = []

    # --- 画像生成（Forge モック） ---
    sd_process._enabled = False
    forge_client.generate_image = lambda **kw: Image.new("RGB", (96, 64), (10, 200, 30))

    meta = service.generate_image_to_item(
        {
            "folder": "gen",
            "positive": "a cat on the beach",
            "negative": "blurry",
            "steps": 20,
            "cfg": 5.5,
            "sampler": "Euler a",
            "width": 96,
            "height": 64,
            "seed": 42,
            "backend": "WebUI Forge",
        },
        statuses.append,
    )
    assert meta["prompt"] == "a cat on the beach"
    assert meta["seed"] == 42
    assert meta["params"]["backend"] == "WebUI Forge"
    assert meta["params"]["width"] == 96 and meta["params"]["height"] == 64
    item_dir = TMP_ROOT / "gen" / meta["id"]
    assert (item_dir / "image.png").is_file()
    assert (item_dir / "thumb.jpg").is_file()
    assert index_db.get_item_row(meta["id"]) is not None
    assert index_db.search_items("beach")[0]["id"] == meta["id"]
    assert any("生成中" in s for s in statuses)

    # seed=-1 のとき seed は未確定として None 保存
    meta2 = service.generate_image_to_item(
        {"folder": "gen", "positive": "x", "seed": -1, "backend": "WebUI Forge"},
        statuses.append,
    )
    assert meta2["seed"] is None

    # near_item 指定時は元アイテムのすぐ上（グリッドの左隣）に並ぶ
    meta_near = service.generate_image_to_item(
        {
            "folder": "gen",
            "positive": "near test",
            "seed": -1,
            "backend": "WebUI Forge",
            "near_item": meta["id"],
        },
        statuses.append,
    )
    assert meta_near["sort_order"] > meta["sort_order"]
    listed = [r["id"] for r in index_db.list_items("gen")]
    assert listed.index(meta_near["id"]) == listed.index(meta["id"]) - 1
    # 参照元が存在しなくても生成は成功する
    meta_gone = service.generate_image_to_item(
        {"folder": "gen", "positive": "y", "seed": -1, "backend": "WebUI Forge",
         "near_item": "no-such-item"},
        statuses.append,
    )
    assert meta_gone["id"]

    # --- 動画生成（ComfyUI モック） ---
    comfy_process._enabled = False

    def fake_video(**kw):
        assert kw["input_image"] is not None
        assert kw["positive"] == "waves moving"
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        tmp.write(b"fake-video-bytes")
        tmp.close()
        return tmp.name

    comfy_client.generate_image = fake_video

    meta3 = service.generate_video_for_item(
        {
            "item_id": meta["id"],
            "prompt": "waves moving",
            "workflow": "wan_test",
            "seed": -1,
        },
        statuses.append,
    )
    assert len(meta3["videos"]) == 1
    v = meta3["videos"][0]
    assert v["file"] == "videos/v001.mp4"
    assert v["prompt"] == "waves moving"
    assert v["workflow"] == "wan_test"
    assert (item_dir / "videos" / "v001.mp4").read_bytes() == b"fake-video-bytes"
    assert index_db.get_item_row(meta["id"])["video_count"] == 1

    # --- アプリ全体が import できる ---
    import server.main  # noqa: F401

    # --- 生成オプション（実ワークフローの検出） ---
    from server.routes.generation import get_options

    opts = get_options()
    assert "WebUI Forge" in opts["backends"]
    assert len(opts["image_workflows"]) > 0, "workflows/image が検出されていません"
    assert len(opts["video_workflows"]) > 0, "workflows/video が検出されていません"

    print("ALL OK")
    print("image workflows:", opts["image_workflows"])
    print("video workflows:", len(opts["video_workflows"]), "件")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
