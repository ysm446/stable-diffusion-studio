"""画像アイテムの CRUD。

書き込み順序は「ファイル → meta.json → インデックス」で統一する
（途中でクラッシュしてもインデックス再構築で復旧できる）。
"""

from __future__ import annotations

import io
import shutil
import time
from pathlib import Path
from typing import Any

from PIL import Image

from server.library import index_db, paths, png_meta
from server.library.meta import load_meta, new_meta, now_iso, save_meta
from server.library.thumbs import make_thumb


class LibraryError(Exception):
    pass


class NotFound(LibraryError):
    pass


def _retry_fs(fn, attempts: int = 4, wait: float = 0.3):
    """Windows の一時的なファイルロック（WinError 5/32）を短時間リトライする。"""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise LibraryError(
                    "ファイルが使用中のため操作できません。"
                    "エクスプローラーのウィンドウや再生中の動画を閉じてから再試行してください。"
                )
            time.sleep(wait)


def item_dir(item_id: str) -> Path:
    """ID からアイテムフォルダを引く（インデックス → 全走査フォールバック）。"""
    row = index_db.get_item_row(item_id)
    if row is not None:
        d = paths.resolve_rel(row["folder"]) / item_id
        if paths.is_item_dir(d):
            return d
    root = paths.get_library_root()
    stack = [root]
    while stack:
        current = stack.pop()
        for child in current.iterdir():
            if not child.is_dir() or child.name.startswith("."):
                continue
            if child.name == item_id and paths.is_item_dir(child):
                return child
            if not paths.is_item_dir(child):
                stack.append(child)
    raise NotFound(f"item not found: {item_id}")


def get_item(item_id: str) -> dict[str, Any]:
    d = item_dir(item_id)
    meta = load_meta(d)
    root = paths.get_library_root()
    folder = d.parent.relative_to(root).as_posix()
    meta["folder"] = "" if folder == "." else folder
    return meta


def create_item(
    folder_rel: str,
    image_bytes: bytes,
    *,
    ext: str = ".png",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int | None = None,
    params: dict[str, Any] | None = None,
    tags: list[str] | None = None,
    caption: str = "",
) -> dict[str, Any]:
    folder_rel = paths.normalize_rel(folder_rel)
    folder = paths.resolve_rel(folder_rel)
    if not folder.is_dir():
        raise LibraryError(f"folder not found: {folder_rel!r}")
    if paths.is_item_dir(folder):
        raise LibraryError("cannot create an item inside another item")

    item_id = paths.new_item_id()
    d = folder / item_id
    d.mkdir()
    image_file = f"image{ext}"
    try:
        (d / image_file).write_bytes(image_bytes)
        make_thumb(image_bytes, d / "thumb.jpg")
        meta = new_meta(
            item_id,
            image_file=image_file,
            prompt=prompt,
            negative_prompt=negative_prompt,
            seed=seed,
            params=params,
            tags=tags,
            caption=caption,
        )
        save_meta(d, meta)
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        raise
    index_db.upsert_item(meta, folder_rel)
    meta["folder"] = folder_rel
    return meta


def import_image(folder_rel: str, image_bytes: bytes, filename: str = "") -> dict[str, Any]:
    """既存の画像ファイルを取り込む。PNG メタデータからプロンプト等を読み取る。"""
    ext = Path(filename).suffix.lower() or ".png"
    if ext not in (".png", ".jpg", ".jpeg", ".webp"):
        raise LibraryError(f"unsupported image type: {ext}")
    prompt = negative = ""
    seed = None
    params: dict[str, Any] = {}
    try:
        with Image.open(io.BytesIO(image_bytes)) as im:
            info = png_meta.read_a1111_metadata(im) or png_meta.read_comfyui_metadata(im)
        if info:
            prompt = info.get("positive") or ""
            negative = info.get("negative") or ""
            seed = info.get("seed")
            params = {
                k: v
                for k, v in info.items()
                if k not in ("positive", "negative", "seed", "size") and v is not None
            }
    except Exception:
        pass
    return create_item(
        folder_rel,
        image_bytes,
        ext=ext,
        prompt=prompt,
        negative_prompt=negative,
        seed=seed,
        params=params,
    )


def update_item(item_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    d = item_dir(item_id)
    meta = load_meta(d)
    for key in (
        "prompt",
        "negative_prompt",
        "caption",
        "seed",
        "params",
        "tags",
        "video_settings",
    ):
        if key in fields:
            meta[key] = fields[key]
    save_meta(d, meta)
    root = paths.get_library_root()
    folder = d.parent.relative_to(root).as_posix()
    folder = "" if folder == "." else folder
    index_db.upsert_item(meta, folder)
    meta["folder"] = folder
    return meta


def delete_item(item_id: str) -> None:
    d = item_dir(item_id)
    _retry_fs(lambda: shutil.rmtree(d))
    index_db.remove_item(item_id)


def move_item(item_id: str, dest_folder_rel: str) -> dict[str, Any]:
    dest_rel = paths.normalize_rel(dest_folder_rel)
    dest_folder = paths.resolve_rel(dest_rel)
    if not dest_folder.is_dir():
        raise LibraryError(f"folder not found: {dest_folder_rel!r}")
    if paths.is_item_dir(dest_folder):
        raise LibraryError("cannot move an item inside another item")
    d = item_dir(item_id)
    dest = dest_folder / item_id
    if dest.exists():
        raise LibraryError(f"destination already exists: {dest}")
    _retry_fs(lambda: shutil.move(str(d), str(dest)))
    meta = load_meta(dest)
    index_db.upsert_item(meta, dest_rel)
    meta["folder"] = dest_rel
    return meta


def add_video(
    item_id: str,
    video_bytes: bytes,
    *,
    ext: str = ".mp4",
    prompt: str = "",
    workflow: str = "",
    settings: dict[str, Any] | None = None,
) -> dict[str, Any]:
    d = item_dir(item_id)
    meta = load_meta(d)
    videos_dir = d / paths.VIDEOS_DIR_NAME
    videos_dir.mkdir(exist_ok=True)
    n = 1
    while (videos_dir / f"v{n:03d}{ext}").exists():
        n += 1
    file_rel = f"{paths.VIDEOS_DIR_NAME}/v{n:03d}{ext}"
    (d / file_rel).write_bytes(video_bytes)
    entry = {
        "file": file_rel,
        "prompt": prompt,
        "workflow": workflow,
        "created_at": now_iso(),
    }
    if settings:
        entry["settings"] = settings
    meta.setdefault("videos", []).append(entry)
    save_meta(d, meta)
    root = paths.get_library_root()
    folder = d.parent.relative_to(root).as_posix()
    folder = "" if folder == "." else folder
    index_db.upsert_item(meta, folder)
    meta["folder"] = folder
    return meta


def update_video(item_id: str, file_name: str, fields: dict[str, Any]) -> dict[str, Any]:
    """動画エントリのプロンプト・設定を更新する。"""
    d = item_dir(item_id)
    meta = load_meta(d)
    name = file_name.replace("\\", "/").split("/")[-1]
    file_rel = f"{paths.VIDEOS_DIR_NAME}/{name}"
    target = None
    for v in meta.get("videos") or []:
        if v.get("file") == file_rel:
            target = v
            break
    if target is None:
        raise NotFound(f"video not found: {file_rel}")
    if "prompt" in fields:
        target["prompt"] = fields["prompt"]
    if "workflow" in fields:
        target["workflow"] = fields["workflow"]
    if "settings" in fields and isinstance(fields["settings"], dict):
        target["settings"] = {**(target.get("settings") or {}), **fields["settings"]}
    save_meta(d, meta)
    root = paths.get_library_root()
    folder = d.parent.relative_to(root).as_posix()
    folder = "" if folder == "." else folder
    index_db.upsert_item(meta, folder)
    meta["folder"] = folder
    return meta


def remove_video(item_id: str, file_name: str) -> dict[str, Any]:
    """動画を削除する。file_name は ``videos/v001.mp4`` またはファイル名のみ。"""
    d = item_dir(item_id)
    meta = load_meta(d)
    name = file_name.replace("\\", "/").split("/")[-1]
    if "/" in name or name in ("", ".", ".."):
        raise LibraryError(f"invalid video file name: {file_name!r}")
    file_rel = f"{paths.VIDEOS_DIR_NAME}/{name}"
    videos = meta.get("videos") or []
    kept = [v for v in videos if v.get("file") != file_rel]
    if len(kept) == len(videos):
        raise NotFound(f"video not found: {file_rel}")
    target = d / file_rel
    if target.is_file():
        _retry_fs(target.unlink)
    thumb = target.with_suffix(".thumb.jpg")
    if thumb.is_file():
        _retry_fs(thumb.unlink)
    meta["videos"] = kept
    save_meta(d, meta)
    root = paths.get_library_root()
    folder = d.parent.relative_to(root).as_posix()
    folder = "" if folder == "." else folder
    index_db.upsert_item(meta, folder)
    meta["folder"] = folder
    return meta
