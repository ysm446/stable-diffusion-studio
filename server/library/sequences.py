"""シーケンス（クリップの並び）の CRUD。

シーケンスは ``.studio/sequences/<id>.json`` に保存する。クリップは
``{item_id, file}`` の参照で持ち、実体はアイテムフォルダの動画。
参照切れ（画像・動画の削除）は解決時に ``missing`` フラグで返す。
"""

from __future__ import annotations

import json
from typing import Any

from server.library import items, paths
from server.library.meta import load_meta, now_iso


class SequenceError(Exception):
    pass


class SequenceNotFound(SequenceError):
    pass


def _seq_path(seq_id: str):
    if "/" in seq_id or "\\" in seq_id or seq_id.startswith("."):
        raise SequenceError(f"invalid sequence id: {seq_id!r}")
    return paths.sequences_dir() / f"{seq_id}.json"


def _save(seq: dict[str, Any]) -> None:
    path = _seq_path(seq["id"])
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(seq, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def create_sequence(name: str) -> dict[str, Any]:
    seq = {
        "id": paths.new_item_id(),
        "name": (name or "").strip() or "新しいシーケンス",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "clips": [],
    }
    _save(seq)
    return seq


def list_sequences() -> list[dict[str, Any]]:
    result = []
    for path in sorted(paths.sequences_dir().glob("*.json")):
        try:
            seq = json.loads(path.read_text(encoding="utf-8"))
            result.append(
                {
                    "id": seq["id"],
                    "name": seq.get("name", ""),
                    "clip_count": len(seq.get("clips") or []),
                    "updated_at": seq.get("updated_at"),
                }
            )
        except (OSError, ValueError, KeyError):
            continue
    result.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    return result


def get_sequence(seq_id: str) -> dict[str, Any]:
    path = _seq_path(seq_id)
    if not path.is_file():
        raise SequenceNotFound(f"sequence not found: {seq_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def update_sequence(seq_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    seq = get_sequence(seq_id)
    if "name" in fields:
        name = str(fields["name"]).strip()
        if name:
            seq["name"] = name
    if "clips" in fields:
        clips = fields["clips"]
        if not isinstance(clips, list):
            raise SequenceError("clips must be a list")
        normalized = []
        for c in clips:
            if not isinstance(c, dict) or not c.get("item_id") or not c.get("file"):
                raise SequenceError(f"invalid clip entry: {c!r}")
            normalized.append({"item_id": str(c["item_id"]), "file": str(c["file"])})
        seq["clips"] = normalized
    seq["updated_at"] = now_iso()
    _save(seq)
    return seq


def delete_sequence(seq_id: str) -> None:
    path = _seq_path(seq_id)
    if not path.is_file():
        raise SequenceNotFound(f"sequence not found: {seq_id}")
    path.unlink()


def resolve_clips(seq: dict[str, Any]) -> list[dict[str, Any]]:
    """クリップ参照を実ファイルに解決する。欠落は missing=True で返す。

    表示用に動画プロンプトとアイテムのサムネイル名も付与する。
    """
    resolved = []
    meta_cache: dict[str, dict[str, Any]] = {}
    for clip in seq.get("clips") or []:
        entry: dict[str, Any] = dict(clip)
        entry["missing"] = True
        entry["path"] = None
        try:
            d = items.item_dir(clip["item_id"])
            target = (d / clip["file"]).resolve()
            if d.resolve() in target.parents and target.is_file():
                entry["missing"] = False
                entry["path"] = str(target)
            if clip["item_id"] not in meta_cache:
                meta_cache[clip["item_id"]] = load_meta(d)
            meta = meta_cache[clip["item_id"]]
            entry["thumb"] = meta.get("thumb")
            for v in meta.get("videos") or []:
                if v.get("file") == clip["file"]:
                    entry["prompt"] = v.get("prompt") or ""
                    entry["workflow"] = v.get("workflow") or ""
                    break
        except (items.NotFound, OSError, ValueError):
            pass
        resolved.append(entry)
    return resolved
