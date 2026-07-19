"""シーケンス CRUD と ffmpeg 連結書き出しのスモークテスト。

ffmpeg で小さなテストクリップを実際に生成し、無劣化 concat と
再エンコードフォールバックの両方を検証する。
実行: python tests/test_sequences.py（ffmpeg / ffprobe が PATH に必要）
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP_ROOT = Path(tempfile.mkdtemp(prefix="studio-seq-test-"))
os.environ["STUDIO_LIBRARY_ROOT"] = str(TMP_ROOT)

import io

from PIL import Image

from server.library import folders, items, sequence_export, sequences


def make_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (120, 80, 40)).save(buf, "PNG")
    return buf.getvalue()


def make_clip(color: str, size: str = "320x240", seconds: float = 0.5) -> bytes:
    tmp = Path(tempfile.mkdtemp()) / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "lavfi",
            "-i", f"color=c={color}:s={size}:d={seconds}:r=16",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "ultrafast",
            str(tmp),
        ],
        check=True,
        capture_output=True,
    )
    data = tmp.read_bytes()
    shutil.rmtree(tmp.parent, ignore_errors=True)
    return data


def main() -> None:
    folders.create_folder("", "clips")
    meta = items.create_item("clips", make_png(), prompt="test item")
    item_id = meta["id"]
    items.add_video(item_id, make_clip("red"), prompt="red clip")
    items.add_video(item_id, make_clip("blue"), prompt="blue clip")

    # --- CRUD ---
    seq = sequences.create_sequence("テスト")
    assert sequences.list_sequences()[0]["id"] == seq["id"]
    seq = sequences.update_sequence(
        seq["id"],
        {
            "clips": [
                {"item_id": item_id, "file": "videos/v001.mp4"},
                {"item_id": item_id, "file": "videos/v002.mp4"},
            ]
        },
    )
    resolved = sequences.resolve_clips(seq)
    assert len(resolved) == 2 and not any(c["missing"] for c in resolved)

    statuses: list[str] = []

    # --- 無劣化 concat（同一パラメータ） ---
    result = sequence_export.export_sequence(seq["id"], statuses.append)
    assert result["mode"] == "copy", result
    out = Path(result["path"])
    assert out.is_file() and out.stat().st_size > 0
    info = sequence_export.probe(str(out))
    assert info["width"] == 320 and info["height"] == 240

    # --- 再エンコードフォールバック（解像度混在） ---
    items.add_video(item_id, make_clip("green", size="480x360"), prompt="green clip")
    seq = sequences.update_sequence(
        seq["id"],
        {
            "clips": [
                {"item_id": item_id, "file": "videos/v001.mp4"},
                {"item_id": item_id, "file": "videos/v003.mp4"},
            ]
        },
    )
    result2 = sequence_export.export_sequence(seq["id"], statuses.append)
    assert result2["mode"] == "reencode", result2
    out2 = Path(result2["path"])
    info2 = sequence_export.probe(str(out2))
    assert info2["width"] == 320 and info2["height"] == 240  # 先頭クリップに正規化

    # --- 欠落クリップの検出 ---
    items.remove_video(item_id, "v001.mp4")
    seq = sequences.get_sequence(seq["id"])
    resolved = sequences.resolve_clips(seq)
    assert resolved[0]["missing"] is True
    try:
        sequence_export.export_sequence(seq["id"], statuses.append)
        raise AssertionError("欠落クリップでエラーになるべき")
    except sequence_export.ExportError as e:
        assert "欠落" in str(e)

    # --- 削除 ---
    sequences.delete_sequence(seq["id"])
    assert sequences.list_sequences() == []

    print("ALL OK")
    print("copy export:", out.name, out.stat().st_size, "bytes")
    print("reencode export:", out2.name, out2.stat().st_size, "bytes")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
