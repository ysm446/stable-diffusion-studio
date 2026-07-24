"""シーケンス（クリップのノードグラフ）の CRUD。

シーケンスは ``.studio/sequences/<id>.json`` に保存する。クリップは
``{item_id, file}`` の参照でノードとして持ち、ノード間を edge（out→in の一本道）で
つなぐ。実体はアイテムフォルダの動画。参照切れ（画像・動画の削除）は解決時に
``missing`` フラグで返す。

一覧の整理用に 1 段のフォルダ分けができる。フォルダは表示上のグループで、
各シーケンス JSON の ``folder`` フィールド（フォルダ名の文字列）で所属を持つ。
フォルダ自体の一覧と表示順は ``.studio/sequences/folders.json`` に保存する
（空フォルダを保持するため）。``folder`` なしは「未分類」。

旧形式（``clips`` の線形リスト）は読み込み時に nodes+edges の一本道へ自動移行する。
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


def create_sequence(name: str, folder: str = "") -> dict[str, Any]:
    seq = {
        "id": paths.new_item_id(),
        "name": (name or "").strip() or "新しいシーケンス",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "nodes": [],
        "edges": [],
    }
    folder = (folder or "").strip()
    if folder:
        seq["folder"] = _validate_folder_name(folder)
        _ensure_folder(seq["folder"])
    _save(seq)
    return seq


# フォルダ（1 段のグループ分け） ------------------------------------------------

_FOLDERS_FILE = "folders.json"


def _folders_path():
    return paths.sequences_dir() / _FOLDERS_FILE


def _validate_folder_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise SequenceError("フォルダ名を入力してください")
    if "/" in name or "\\" in name:
        raise SequenceError("フォルダ名に / や \\ は使えません")
    return name


def list_folders() -> list[str]:
    path = _folders_path()
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    seen = set()
    out = []
    for n in data.get("folders") or []:
        n = str(n).strip()
        if n and n not in seen:
            seen.add(n)
            out.append(n)
    return out


def _save_folders(names: list[str]) -> None:
    path = _folders_path()
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(
        json.dumps({"folders": names}, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(path)


def _ensure_folder(name: str) -> None:
    folders = list_folders()
    if name not in folders:
        folders.append(name)
        _save_folders(folders)


def create_folder(name: str) -> list[str]:
    name = _validate_folder_name(name)
    folders = list_folders()
    if name in folders:
        raise SequenceError(f"フォルダ「{name}」は既にあります")
    folders.append(name)
    _save_folders(folders)
    return folders


def _reassign_folder(old: str, new: str | None) -> None:
    """フォルダ old に属する全シーケンスを new へ付け替える（None は未分類へ）。

    整理操作なので updated_at は変更しない。
    """
    for path in paths.sequences_dir().glob("*.json"):
        if path.name == _FOLDERS_FILE:
            continue
        try:
            seq = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if seq.get("folder") != old or "id" not in seq:
            continue
        if new:
            seq["folder"] = new
        else:
            seq.pop("folder", None)
        _save(seq)


def rename_folder(old: str, new: str) -> list[str]:
    new = _validate_folder_name(new)
    folders = list_folders()
    if old not in folders:
        raise SequenceNotFound(f"folder not found: {old!r}")
    if new == old:
        return folders
    if new in folders:
        raise SequenceError(f"フォルダ「{new}」は既にあります")
    _save_folders([new if n == old else n for n in folders])
    _reassign_folder(old, new)
    return list_folders()


def delete_folder(name: str) -> list[str]:
    """フォルダを削除する。中のシーケンスは削除せず未分類へ戻す。"""
    folders = list_folders()
    if name not in folders:
        raise SequenceNotFound(f"folder not found: {name!r}")
    _save_folders([n for n in folders if n != name])
    _reassign_folder(name, None)
    return list_folders()


def _migrate(seq: dict[str, Any]) -> dict[str, Any]:
    """旧形式（clips の線形リスト）を nodes+edges へ移行する。"""
    if "nodes" in seq:
        seq.setdefault("edges", [])
        return seq
    clips = seq.get("clips") or []
    nodes = []
    edges = []
    for i, c in enumerate(clips):
        nid = i + 1
        nodes.append(
            {
                "id": nid,
                "item_id": str(c.get("item_id", "")),
                "file": str(c.get("file", "")),
                "x": 40 + i * 180,
                "y": 60,
            }
        )
        if i > 0:
            edges.append({"src": i, "dst": nid})
    seq["nodes"] = nodes
    seq["edges"] = edges
    seq.pop("clips", None)
    return seq


def node_order(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[int]:
    """edge から最長の一本道（順路）のノード ID 列を返す。

    各ノードの out は高々1本。入辺のないノードを起点に鎖を辿り、最長のものを採用する。
    """
    next_of: dict[int, int] = {}
    has_incoming: set[int] = set()
    node_ids = [n["id"] for n in nodes]
    id_set = set(node_ids)
    for e in edges:
        src, dst = e.get("src"), e.get("dst")
        if src in id_set and dst in id_set:
            next_of[src] = dst
            has_incoming.add(dst)
    starts = [nid for nid in node_ids if nid not in has_incoming]
    best: list[int] = []
    for start in starts:
        chain: list[int] = []
        seen: set[int] = set()
        cur: int | None = start
        while cur is not None and cur not in seen:
            chain.append(cur)
            seen.add(cur)
            cur = next_of.get(cur)
        if len(chain) > len(best):
            best = chain
    return best


def list_sequences() -> list[dict[str, Any]]:
    result = []
    for path in sorted(paths.sequences_dir().glob("*.json")):
        if path.name == _FOLDERS_FILE:
            continue
        try:
            seq = json.loads(path.read_text(encoding="utf-8"))
            n = len(seq.get("nodes") if "nodes" in seq else (seq.get("clips") or []))
            result.append(
                {
                    "id": seq["id"],
                    "name": seq.get("name", ""),
                    "folder": str(seq.get("folder") or ""),
                    "clip_count": n,
                    "updated_at": seq.get("updated_at"),
                    "sort_order": seq.get("sort_order"),
                }
            )
        except (OSError, ValueError, KeyError):
            continue
    # 手動並べ替え済み（sort_order あり）はその順、未設定（新規作成直後など）は
    # 更新日時の新しい順で先頭に置く
    fresh = [s for s in result if s.get("sort_order") is None]
    ordered = [s for s in result if s.get("sort_order") is not None]
    fresh.sort(key=lambda s: s.get("updated_at") or "", reverse=True)
    ordered.sort(key=lambda s: s["sort_order"])
    return fresh + ordered


def reorder_sequences(ids: list[str]) -> None:
    """一覧の表示順を保存する。ids は表示順（上から下）のシーケンス ID。

    updated_at は変更しない（並べ替えは内容の編集ではないため）。
    """
    for i, seq_id in enumerate(ids):
        try:
            seq = get_sequence(seq_id)
        except SequenceNotFound:
            continue
        seq["sort_order"] = i
        _save(seq)


def get_sequence(seq_id: str) -> dict[str, Any]:
    path = _seq_path(seq_id)
    if not path.is_file():
        raise SequenceNotFound(f"sequence not found: {seq_id}")
    return _migrate(json.loads(path.read_text(encoding="utf-8")))


def _validate_nodes(nodes: Any) -> list[dict[str, Any]]:
    if not isinstance(nodes, list):
        raise SequenceError("nodes must be a list")
    out = []
    seen_ids = set()
    for n in nodes:
        if not isinstance(n, dict) or not n.get("item_id") or not n.get("file"):
            raise SequenceError(f"invalid node: {n!r}")
        nid = int(n["id"])
        if nid in seen_ids:
            raise SequenceError(f"duplicate node id: {nid}")
        seen_ids.add(nid)
        out.append(
            {
                "id": nid,
                "item_id": str(n["item_id"]),
                "file": str(n["file"]),
                "x": float(n.get("x", 0)),
                "y": float(n.get("y", 0)),
            }
        )
    return out


def _validate_edges(edges: Any, node_ids: set[int]) -> list[dict[str, Any]]:
    if not isinstance(edges, list):
        raise SequenceError("edges must be a list")
    out = []
    used_src = set()
    used_dst = set()
    for e in edges:
        src, dst = int(e["src"]), int(e["dst"])
        # 一本道: 各ノードの out/in は高々1本、自己ループ禁止
        if src == dst or src not in node_ids or dst not in node_ids:
            continue
        if src in used_src or dst in used_dst:
            continue
        used_src.add(src)
        used_dst.add(dst)
        out.append({"src": src, "dst": dst})
    return out


def update_sequence(seq_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    seq = get_sequence(seq_id)
    if "name" in fields:
        name = str(fields["name"]).strip()
        if name:
            seq["name"] = name
    if "folder" in fields:
        folder = fields["folder"]
        if folder is None or str(folder).strip() == "":
            seq.pop("folder", None)
        else:
            folder = _validate_folder_name(str(folder))
            _ensure_folder(folder)
            seq["folder"] = folder
    if "bgm" in fields:
        bgm = fields["bgm"]
        if bgm is None or bgm == {}:
            seq.pop("bgm", None)
        elif isinstance(bgm, dict) and bgm.get("file"):
            vol = bgm.get("volume", 0.8)
            try:
                vol = max(0.0, min(1.0, float(vol)))
            except (TypeError, ValueError):
                vol = 0.8
            seq["bgm"] = {"file": str(bgm["file"]), "volume": vol}
        else:
            raise SequenceError(f"invalid bgm: {bgm!r}")
    if "nodes" in fields:
        seq["nodes"] = _validate_nodes(fields["nodes"])
    if "edges" in fields:
        node_ids = {n["id"] for n in seq["nodes"]}
        seq["edges"] = _validate_edges(fields["edges"], node_ids)
    else:
        # ノード更新でノードが減った場合、無効な edge を落とす
        node_ids = {n["id"] for n in seq["nodes"]}
        seq["edges"] = _validate_edges(seq.get("edges") or [], node_ids)
    # フォルダ移動だけなら内容の編集ではないため updated_at は変えない
    if set(fields) != {"folder"}:
        seq["updated_at"] = now_iso()
    _save(seq)
    return seq


def delete_sequence(seq_id: str) -> None:
    path = _seq_path(seq_id)
    if not path.is_file():
        raise SequenceNotFound(f"sequence not found: {seq_id}")
    path.unlink()


def resolve_nodes(seq: dict[str, Any]) -> list[dict[str, Any]]:
    """全ノードを実ファイルに解決する（表示用。missing・thumb・prompt を付与）。"""
    resolved = []
    meta_cache: dict[str, dict[str, Any]] = {}
    for node in seq.get("nodes") or []:
        entry: dict[str, Any] = dict(node)
        entry["missing"] = True
        entry["path"] = None
        try:
            d = items.item_dir(node["item_id"])
            target = (d / node["file"]).resolve()
            if d.resolve() in target.parents and target.is_file():
                entry["missing"] = False
                entry["path"] = str(target)
            if node["item_id"] not in meta_cache:
                meta_cache[node["item_id"]] = load_meta(d)
            meta = meta_cache[node["item_id"]]
            entry["thumb"] = meta.get("thumb")
            for v in meta.get("videos") or []:
                if v.get("file") == node["file"]:
                    entry["prompt"] = v.get("prompt") or ""
                    break
        except (items.NotFound, OSError, ValueError):
            pass
        resolved.append(entry)
    return resolved


def resolve_ordered_clips(seq: dict[str, Any]) -> list[dict[str, Any]]:
    """順路（node_order）に沿って解決済みクリップを返す（書き出し用）。"""
    by_id = {n["id"]: n for n in resolve_nodes(seq)}
    order = node_order(seq.get("nodes") or [], seq.get("edges") or [])
    return [by_id[nid] for nid in order if nid in by_id]
