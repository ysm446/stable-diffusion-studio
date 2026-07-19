"""検索用 SQLite インデックス。

フォルダ（meta.json）が正で、この DB は常に再構築できるキャッシュ。
一覧・検索はここを経由し、ファイルシステムの全走査を避ける。
"""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from server.library import paths
from server.library.meta import load_meta

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    created_at TEXT,
    image TEXT,
    thumb TEXT,
    prompt TEXT DEFAULT '',
    negative_prompt TEXT DEFAULT '',
    caption TEXT DEFAULT '',
    seed INTEGER,
    params TEXT DEFAULT '{}',
    tags TEXT DEFAULT '[]',
    video_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_folder ON items(folder);
CREATE TABLE IF NOT EXISTS videos (
    item_id TEXT NOT NULL,
    file TEXT NOT NULL,
    prompt TEXT DEFAULT '',
    workflow TEXT DEFAULT '',
    created_at TEXT,
    PRIMARY KEY (item_id, file)
);
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
    id UNINDEXED, prompt, negative_prompt, caption, tags
);
CREATE TABLE IF NOT EXISTS item_embeddings (
    item_id TEXT PRIMARY KEY,
    model TEXT DEFAULT '',
    dim INTEGER DEFAULT 0,
    text_hash TEXT DEFAULT '',
    vector BLOB
);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(paths.db_path())
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def _row_to_item(row: sqlite3.Row) -> dict[str, Any]:
    item = dict(row)
    item["params"] = json.loads(item.get("params") or "{}")
    item["tags"] = json.loads(item.get("tags") or "[]")
    return item


def upsert_item(meta: dict[str, Any], folder: str, conn: sqlite3.Connection | None = None) -> None:
    own = conn is None
    conn = conn or connect()
    try:
        videos = meta.get("videos") or []
        conn.execute(
            """
            INSERT OR REPLACE INTO items
                (id, folder, created_at, image, thumb, prompt, negative_prompt,
                 caption, seed, params, tags, video_count)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                meta["id"],
                folder,
                meta.get("created_at"),
                meta.get("image"),
                meta.get("thumb"),
                meta.get("prompt") or "",
                meta.get("negative_prompt") or "",
                meta.get("caption") or "",
                meta.get("seed"),
                json.dumps(meta.get("params") or {}, ensure_ascii=False),
                json.dumps(meta.get("tags") or [], ensure_ascii=False),
                len(videos),
            ),
        )
        conn.execute("DELETE FROM videos WHERE item_id = ?", (meta["id"],))
        for v in videos:
            conn.execute(
                "INSERT OR REPLACE INTO videos (item_id, file, prompt, workflow, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    meta["id"],
                    v.get("file"),
                    v.get("prompt") or "",
                    v.get("workflow") or "",
                    v.get("created_at"),
                ),
            )
        conn.execute("DELETE FROM items_fts WHERE id = ?", (meta["id"],))
        conn.execute(
            "INSERT INTO items_fts (id, prompt, negative_prompt, caption, tags)"
            " VALUES (?, ?, ?, ?, ?)",
            (
                meta["id"],
                meta.get("prompt") or "",
                meta.get("negative_prompt") or "",
                meta.get("caption") or "",
                " ".join(meta.get("tags") or []),
            ),
        )
        conn.commit()
    finally:
        if own:
            conn.close()


def remove_item(item_id: str, conn: sqlite3.Connection | None = None) -> None:
    own = conn is None
    conn = conn or connect()
    try:
        conn.execute("DELETE FROM items WHERE id = ?", (item_id,))
        conn.execute("DELETE FROM videos WHERE item_id = ?", (item_id,))
        conn.execute("DELETE FROM items_fts WHERE id = ?", (item_id,))
        conn.execute("DELETE FROM item_embeddings WHERE item_id = ?", (item_id,))
        conn.commit()
    finally:
        if own:
            conn.close()


def get_item_row(item_id: str) -> dict[str, Any] | None:
    conn = connect()
    try:
        row = conn.execute("SELECT * FROM items WHERE id = ?", (item_id,)).fetchone()
        return _row_to_item(row) if row else None
    finally:
        conn.close()


def list_items(folder: str = "", recursive: bool = False) -> list[dict[str, Any]]:
    conn = connect()
    try:
        if recursive:
            if folder:
                rows = conn.execute(
                    "SELECT * FROM items WHERE folder = ? OR folder LIKE ?"
                    " ORDER BY created_at DESC",
                    (folder, folder + "/%"),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM items ORDER BY created_at DESC"
                ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM items WHERE folder = ? ORDER BY created_at DESC",
                (folder,),
            ).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def search_items(query: str, folder: str = "") -> list[dict[str, Any]]:
    tokens = [t.replace('"', "") for t in query.split() if t.replace('"', "")]
    if not tokens:
        return []
    fts_query = " ".join(f'"{t}"' for t in tokens)
    conn = connect()
    try:
        sql = (
            "SELECT items.* FROM items_fts JOIN items ON items.id = items_fts.id"
            " WHERE items_fts MATCH ?"
        )
        args: list[Any] = [fts_query]
        if folder:
            sql += " AND (items.folder = ? OR items.folder LIKE ?)"
            args += [folder, folder + "/%"]
        sql += " ORDER BY rank"
        rows = conn.execute(sql, args).fetchall()
        return [_row_to_item(r) for r in rows]
    finally:
        conn.close()


def list_all_videos() -> list[dict[str, Any]]:
    """全動画をアイテム情報付きで返す（シーケンスのクリップパレット用）。"""
    conn = connect()
    try:
        rows = conn.execute(
            """
            SELECT videos.item_id, videos.file, videos.prompt, videos.workflow,
                   videos.created_at, items.folder, items.thumb,
                   items.prompt AS item_prompt
            FROM videos JOIN items ON items.id = videos.item_id
            ORDER BY videos.created_at DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def move_folder_prefix(old: str, new: str) -> None:
    """フォルダのリネーム / 移動に合わせて items.folder を付け替える。"""
    conn = connect()
    try:
        conn.execute(
            "UPDATE items SET folder = ? || substr(folder, ?)"
            " WHERE folder = ? OR folder LIKE ?",
            (new, len(old) + 1, old, old + "/%"),
        )
        conn.commit()
    finally:
        conn.close()


def remove_folder_items(folder: str) -> None:
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id FROM items WHERE folder = ? OR folder LIKE ?",
            (folder, folder + "/%"),
        ).fetchall()
        for row in rows:
            remove_item(row["id"], conn)
    finally:
        conn.close()


def rebuild() -> int:
    """ライブラリ全体を走査してインデックスを作り直す。件数を返す。"""
    root = paths.get_library_root()
    conn = connect()
    try:
        conn.execute("DELETE FROM items")
        conn.execute("DELETE FROM videos")
        conn.execute("DELETE FROM items_fts")
        conn.commit()
        count = 0
        stack = [root]
        while stack:
            current = stack.pop()
            for child in current.iterdir():
                if not child.is_dir() or child.name.startswith("."):
                    continue
                if paths.is_item_dir(child):
                    try:
                        meta = load_meta(child)
                    except (OSError, ValueError, json.JSONDecodeError):
                        continue
                    folder = child.parent.relative_to(root).as_posix()
                    folder = "" if folder == "." else folder
                    upsert_item(meta, folder, conn)
                    count += 1
                else:
                    stack.append(child)
        return count
    finally:
        conn.close()
