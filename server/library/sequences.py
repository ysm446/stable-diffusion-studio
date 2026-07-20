"""シーケンス（クリップのノードグラフ）の CRUD。

シーケンスは ``.studio/sequences/<id>.json`` に保存する。クリップは
``{item_id, file}`` の参照でノードとして持ち、ノード間を edge（out→in の一本道）で
つなぐ。実体はアイテムフォルダの動画。参照切れ（画像・動画の削除）は解決時に
``missing`` フラグで返す。

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


def create_sequence(name: str) -> dict[str, Any]:
    seq = {
        "id": paths.new_item_id(),
        "name": (name or "").strip() or "新しいシーケンス",
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "nodes": [],
        "edges": [],
    }
    _save(seq)
    return seq


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
        try:
            seq = json.loads(path.read_text(encoding="utf-8"))
            n = len(seq.get("nodes") if "nodes" in seq else (seq.get("clips") or []))
            result.append(
                {
                    "id": seq["id"],
                    "name": seq.get("name", ""),
                    "clip_count": n,
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
    if "nodes" in fields:
        seq["nodes"] = _validate_nodes(fields["nodes"])
    if "edges" in fields:
        node_ids = {n["id"] for n in seq["nodes"]}
        seq["edges"] = _validate_edges(fields["edges"], node_ids)
    else:
        # ノード更新でノードが減った場合、無効な edge を落とす
        node_ids = {n["id"] for n in seq["nodes"]}
        seq["edges"] = _validate_edges(seq.get("edges") or [], node_ids)
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
