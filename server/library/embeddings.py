"""アイテムの embedding インデックスとベクトル / ハイブリッド検索。

embedding は ``item_embeddings`` テーブル（index.sqlite3 内）に保存する。
テキストのハッシュを持ち、プロンプト・タグ・キャプションが変わったアイテムだけ
再計算する（差分更新）。ベクトル化は server.generation.embedding_client
（llama-server の /v1/embeddings）に委譲する。
"""

from __future__ import annotations

import hashlib
import math
import struct
from typing import Any, Callable

from server.library import index_db

SCHEMA = """
CREATE TABLE IF NOT EXISTS item_embeddings (
    item_id TEXT PRIMARY KEY,
    model TEXT DEFAULT '',
    dim INTEGER DEFAULT 0,
    text_hash TEXT DEFAULT '',
    vector BLOB
);
"""

EmbedFn = Callable[[str], tuple[list[float], str]]
StatusFn = Callable[[str], None]


def _connect():
    conn = index_db.connect()
    conn.executescript(SCHEMA)
    return conn


def text_for_item(item: dict[str, Any]) -> str:
    parts = [
        f"Tags: {', '.join(item.get('tags') or [])}",
        f"Positive prompt: {item.get('prompt', '')}",
        f"Negative prompt: {item.get('negative_prompt', '')}",
        f"Caption: {item.get('caption', '')}",
    ]
    return "\n".join(p for p in parts if p.split(":", 1)[1].strip())


def _text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _pack(vector: list[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *[float(v) for v in vector])


def _unpack(raw: bytes) -> tuple[float, ...]:
    return struct.unpack(f"<{len(raw) // 4}f", raw)


def pending_items() -> list[dict[str, Any]]:
    """embedding が未計算、またはテキストが変わったアイテムを返す。"""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT items.*, item_embeddings.text_hash AS eh
            FROM items LEFT JOIN item_embeddings
                ON item_embeddings.item_id = items.id
            """
        ).fetchall()
    finally:
        conn.close()
    pending = []
    for row in rows:
        item = index_db._row_to_item(row)
        text = text_for_item(item)
        if not text.strip():
            continue
        if item.get("eh") != _text_hash(text):
            item["_embed_text"] = text
            pending.append(item)
    return pending


def rebuild_embeddings(embed: EmbedFn, status: StatusFn) -> int:
    """未計算 / 変更済みアイテムの embedding を差分更新する。件数を返す。"""
    targets = pending_items()
    if not targets:
        status("embedding は最新です")
        return 0
    done = 0
    conn = _connect()
    try:
        # 孤児（削除済みアイテムの embedding）も掃除する
        conn.execute(
            "DELETE FROM item_embeddings WHERE item_id NOT IN (SELECT id FROM items)"
        )
        for item in targets:
            text = item["_embed_text"]
            vector, model = embed(text)
            conn.execute(
                "INSERT OR REPLACE INTO item_embeddings"
                " (item_id, model, dim, text_hash, vector) VALUES (?, ?, ?, ?, ?)",
                (item["id"], model, len(vector), _text_hash(text), _pack(vector)),
            )
            conn.commit()
            done += 1
            status(f"embedding 更新中... {done}/{len(targets)}")
    finally:
        conn.close()
    return done


def embedding_status() -> dict[str, int]:
    conn = _connect()
    try:
        total = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        embedded = conn.execute(
            "SELECT COUNT(*) FROM item_embeddings"
            " WHERE item_id IN (SELECT id FROM items)"
        ).fetchone()[0]
    finally:
        conn.close()
    return {"total": total, "embedded": embedded, "pending": len(pending_items())}


def search_by_vector(
    query_vector: list[float], folder: str = "", limit: int | None = None
) -> list[dict[str, Any]]:
    """コサイン類似度の降順でアイテムを返す。"""
    qnorm = math.sqrt(sum(x * x for x in query_vector))
    if qnorm == 0:
        return []
    conn = _connect()
    try:
        sql = (
            "SELECT items.*, item_embeddings.vector AS vec FROM item_embeddings"
            " JOIN items ON items.id = item_embeddings.item_id"
            " WHERE item_embeddings.dim > 0"
        )
        args: list[Any] = []
        if folder:
            sql += " AND (items.folder = ? OR items.folder LIKE ?)"
            args += [folder, folder + "/%"]
        rows = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    scored = []
    for row in rows:
        vec = _unpack(row["vec"])
        vnorm = math.sqrt(sum(x * x for x in vec))
        if vnorm == 0:
            continue
        dot = sum(a * b for a, b in zip(query_vector, vec))
        item = index_db._row_to_item(row)
        item.pop("vec", None)
        item["score"] = dot / (qnorm * vnorm)
        scored.append(item)
    scored.sort(key=lambda i: i["score"], reverse=True)
    return scored[:limit] if limit else scored


def search_hybrid(
    query_text: str,
    query_vector: list[float],
    folder: str = "",
    limit: int = 20,
) -> list[dict[str, Any]]:
    """FTS5 とベクトル検索を Reciprocal Rank Fusion で統合する。"""
    vec_results = search_by_vector(query_vector, folder)
    fts_results = index_db.search_items(query_text, folder)

    vec_ranks = {i["id"]: r for r, i in enumerate(vec_results, 1)}
    fts_ranks = {i["id"]: r for r, i in enumerate(fts_results, 1)}

    k = 60
    scores: list[tuple[float, str]] = []
    for id_ in set(vec_ranks) | set(fts_ranks):
        score = 0.0
        if id_ in vec_ranks:
            score += 1.0 / (k + vec_ranks[id_])
        if id_ in fts_ranks:
            score += 1.0 / (k + fts_ranks[id_])
        scores.append((score, id_))
    scores.sort(reverse=True)

    by_id: dict[str, dict[str, Any]] = {}
    for item in [*vec_results, *fts_results]:
        by_id.setdefault(item["id"], item)
    return [by_id[id_] for _, id_ in scores[:limit] if id_ in by_id]
