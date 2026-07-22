"""ユーザーフォルダ（ライブラリ階層）の操作。"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any

from server.library import index_db, paths


class FolderError(Exception):
    pass


def _retry_fs(fn, attempts: int = 4, wait: float = 0.3):
    """Windows の一時的なファイルロック（WinError 5/32）を短時間リトライする。"""
    for i in range(attempts):
        try:
            return fn()
        except PermissionError:
            if i == attempts - 1:
                raise FolderError(
                    "フォルダが使用中のため操作できません。"
                    "エクスプローラーのウィンドウや再生中の動画を閉じてから再試行してください。"
                )
            time.sleep(wait)


def _folder_node(path: Path, root: Path) -> dict[str, Any]:
    rel = path.relative_to(root).as_posix()
    rel = "" if rel == "." else rel
    children = []
    item_count = 0
    for child in sorted(path.iterdir(), key=lambda p: p.name.lower()):
        if not child.is_dir() or child.name.startswith("."):
            continue
        if paths.is_item_dir(child):
            item_count += 1
        else:
            children.append(_folder_node(child, root))
    return {
        "name": path.name if rel else "",
        "rel": rel,
        "item_count": item_count,
        "children": children,
    }


def tree() -> dict[str, Any]:
    root = paths.get_library_root()
    return _folder_node(root, root)


def create_folder(parent_rel: str, name: str) -> str:
    name = paths.validate_folder_name(name)
    parent = paths.resolve_rel(parent_rel)
    if not parent.is_dir():
        raise FolderError(f"parent folder not found: {parent_rel!r}")
    if paths.is_item_dir(parent):
        raise FolderError("cannot create a folder inside an item")
    target = parent / name
    if target.exists():
        raise FolderError(f"folder already exists: {name!r}")
    target.mkdir()
    rel = paths.normalize_rel(f"{paths.normalize_rel(parent_rel)}/{name}")
    return rel


def rename_folder(rel: str, new_name: str) -> str:
    new_name = paths.validate_folder_name(new_name)
    rel = paths.normalize_rel(rel)
    if not rel:
        raise FolderError("cannot rename library root")
    src = paths.resolve_rel(rel)
    if not src.is_dir() or paths.is_item_dir(src):
        raise FolderError(f"folder not found: {rel!r}")
    if new_name == src.name:
        return rel
    dest = src.parent / new_name
    # Windows は大文字小文字を区別しないため、大文字小文字だけの変更では
    # dest が自分自身を指して exists() が真になる。同一フォルダなら許可する。
    case_only = dest.exists() and dest.samefile(src)
    if dest.exists() and not case_only:
        raise FolderError(f"folder already exists: {new_name!r}")
    _retry_fs(lambda: src.rename(dest))
    parent_rel = "/".join(rel.split("/")[:-1])
    new_rel = f"{parent_rel}/{new_name}" if parent_rel else new_name
    index_db.move_folder_prefix(rel, new_rel)
    return new_rel


def move_folder(rel: str, dest_parent_rel: str) -> str:
    rel = paths.normalize_rel(rel)
    if not rel:
        raise FolderError("cannot move library root")
    dest_parent_rel = paths.normalize_rel(dest_parent_rel)
    if dest_parent_rel == rel or dest_parent_rel.startswith(rel + "/"):
        raise FolderError("cannot move a folder into itself")
    src = paths.resolve_rel(rel)
    if not src.is_dir() or paths.is_item_dir(src):
        raise FolderError(f"folder not found: {rel!r}")
    dest_parent = paths.resolve_rel(dest_parent_rel)
    if not dest_parent.is_dir() or paths.is_item_dir(dest_parent):
        raise FolderError(f"destination folder not found: {dest_parent_rel!r}")
    dest = dest_parent / src.name
    if dest.exists():
        raise FolderError(f"destination already exists: {dest}")
    _retry_fs(lambda: shutil.move(str(src), str(dest)))
    new_rel = f"{dest_parent_rel}/{src.name}" if dest_parent_rel else src.name
    index_db.move_folder_prefix(rel, new_rel)
    return new_rel


def delete_folder(rel: str, *, recursive: bool = False) -> None:
    rel = paths.normalize_rel(rel)
    if not rel:
        raise FolderError("cannot delete library root")
    target = paths.resolve_rel(rel)
    if not target.is_dir() or paths.is_item_dir(target):
        raise FolderError(f"folder not found: {rel!r}")
    if any(target.iterdir()) and not recursive:
        raise FolderError("folder is not empty (pass recursive=true to delete)")
    _retry_fs(lambda: shutil.rmtree(target))
    index_db.remove_folder_items(rel)
