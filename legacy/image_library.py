from __future__ import annotations

import hashlib
import io
import json
import re
import sqlite3
import struct
import time
from pathlib import Path
from typing import Any

from PIL import Image

import settings_manager
from prompt_parser import read_a1111_metadata, read_comfyui_metadata

ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_LIBRARY_DIR = ROOT_DIR / "data" / "library"


def get_library_root() -> Path:
    """現在のライブラリのルートフォルダを返す。

    設定 ``library_root`` が指定されていればそれを使い、なければ既定の
    ``data/library`` を返す。相対パスは ROOT_DIR 基準で解決する。
    """
    raw = ""
    try:
        raw = (settings_manager.load().get("library_root") or "").strip()
    except Exception:
        raw = ""
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = (ROOT_DIR / p).resolve()
        return p
    return DEFAULT_LIBRARY_DIR


def _db_path() -> Path:
    return get_library_root() / "library.sqlite3"


def _images_dir() -> Path:
    return get_library_root() / "images"


def _thumbs_dir() -> Path:
    return get_library_root() / "thumbs"


def _ensure_dirs() -> None:
    root = get_library_root()
    root.mkdir(parents=True, exist_ok=True)
    (root / "images").mkdir(parents=True, exist_ok=True)
    (root / "thumbs").mkdir(parents=True, exist_ok=True)


def _to_relative(path_str: str) -> str:
    """保存パスをライブラリルート基準の相対パスへ正規化する。

    保存パスは ``images/<name>`` / ``thumbs/<name>`` の形で保持し、ルート
    フォルダを外部フォルダへ移動しても解決できるようにする。旧データは
    絶対パスや ``data/library/...`` 接頭辞を含む場合があるため、末尾の
    ``images`` / ``thumbs`` セグメント以降を取り出す。
    """
    if not path_str:
        return path_str
    parts = Path(path_str).parts
    for anchor in ("images", "thumbs"):
        if anchor in parts:
            # 最後に現れた anchor 以降を採用する
            idx = len(parts) - 1 - list(reversed(parts)).index(anchor)
            return str(Path(*parts[idx:]))
    p = Path(path_str)
    if p.is_absolute():
        try:
            return str(p.relative_to(get_library_root()))
        except ValueError:
            return path_str
    return path_str


def _resolve(path_str: str) -> Path:
    p = Path(path_str)
    return p if p.is_absolute() else get_library_root() / p


def _migrate_paths(conn: sqlite3.Connection) -> None:
    rows = conn.execute("SELECT id, file_path, thumb_path FROM library_images").fetchall()
    for row in rows:
        new_file = _to_relative(row["file_path"])
        new_thumb = _to_relative(row["thumb_path"])
        if new_file != row["file_path"] or new_thumb != row["thumb_path"]:
            conn.execute(
                "UPDATE library_images SET file_path = ?, thumb_path = ? WHERE id = ?",
                (new_file, new_thumb, row["id"]),
            )
    conn.commit()


def _connect() -> sqlite3.Connection:
    _ensure_dirs()
    conn = sqlite3.connect(_db_path())
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    fts_existed = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='library_images_fts'"
    ).fetchone()[0] > 0
    _init_db(conn)
    _migrate_schema(conn, fts_existed=fts_existed)
    _migrate_paths(conn)
    return conn


def _init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS library_folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS library_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            thumb_path TEXT NOT NULL,
            original_path TEXT,
            sha256 TEXT NOT NULL UNIQUE,
            filename TEXT NOT NULL,
            width INTEGER,
            height INTEGER,
            positive_prompt TEXT DEFAULT '',
            negative_prompt TEXT DEFAULT '',
            raw_metadata TEXT DEFAULT '{}',
            caption TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL,
            indexed_at REAL,
            embedding_model TEXT DEFAULT '',
            embedding_dim INTEGER,
            embedding BLOB
        );
        CREATE INDEX IF NOT EXISTS idx_library_sort
            ON library_images(sort_order, id);
        CREATE INDEX IF NOT EXISTS idx_library_updated
            ON library_images(updated_at);
        """
    )
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS library_images_fts
        USING fts5(
            filename, positive_prompt, negative_prompt, tags, caption, notes,
            content='library_images', content_rowid='id'
        )
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS fts_ai AFTER INSERT ON library_images BEGIN
            INSERT INTO library_images_fts(rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
            VALUES (new.id, new.filename, new.positive_prompt, new.negative_prompt, new.tags, new.caption, new.notes);
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS fts_ad AFTER DELETE ON library_images BEGIN
            INSERT INTO library_images_fts(library_images_fts, rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
            VALUES ('delete', old.id, old.filename, old.positive_prompt, old.negative_prompt, old.tags, old.caption, old.notes);
        END
        """
    )
    conn.execute(
        """
        CREATE TRIGGER IF NOT EXISTS fts_au AFTER UPDATE ON library_images BEGIN
            INSERT INTO library_images_fts(library_images_fts, rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
            VALUES ('delete', old.id, old.filename, old.positive_prompt, old.negative_prompt, old.tags, old.caption, old.notes);
            INSERT INTO library_images_fts(rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
            VALUES (new.id, new.filename, new.positive_prompt, new.negative_prompt, new.tags, new.caption, new.notes);
        END
        """
    )
    conn.commit()


def _migrate_schema(conn: sqlite3.Connection, fts_existed: bool = True) -> None:
    cols = {row[1] for row in conn.execute("PRAGMA table_info(library_images)").fetchall()}
    if "folder_id" not in cols:
        conn.execute(
            "ALTER TABLE library_images ADD COLUMN folder_id INTEGER REFERENCES library_folders(id) ON DELETE SET NULL"
        )
        conn.commit()
    folder_cols = {row[1] for row in conn.execute("PRAGMA table_info(library_folders)").fetchall()}
    if "parent_id" not in folder_cols:
        conn.execute(
            "ALTER TABLE library_folders ADD COLUMN parent_id INTEGER REFERENCES library_folders(id) ON DELETE SET NULL"
        )
        conn.commit()
    if not fts_existed:
        conn.execute("INSERT INTO library_images_fts(library_images_fts) VALUES('rebuild')")
        conn.commit()
        return
    # filename が FTS5 に含まれていない旧スキーマを再作成
    try:
        conn.execute("SELECT filename FROM library_images_fts LIMIT 0")
    except Exception:
        conn.executescript("""
            DROP TRIGGER IF EXISTS fts_ai;
            DROP TRIGGER IF EXISTS fts_ad;
            DROP TRIGGER IF EXISTS fts_au;
            DROP TABLE IF EXISTS library_images_fts;
        """)
        conn.execute(
            """
            CREATE VIRTUAL TABLE library_images_fts
            USING fts5(
                filename, positive_prompt, negative_prompt, tags, caption, notes,
                content='library_images', content_rowid='id'
            )
            """
        )
        conn.executescript("""
            CREATE TRIGGER fts_ai AFTER INSERT ON library_images BEGIN
                INSERT INTO library_images_fts(rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
                VALUES (new.id, new.filename, new.positive_prompt, new.negative_prompt, new.tags, new.caption, new.notes);
            END;
            CREATE TRIGGER fts_ad AFTER DELETE ON library_images BEGIN
                INSERT INTO library_images_fts(library_images_fts, rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
                VALUES ('delete', old.id, old.filename, old.positive_prompt, old.negative_prompt, old.tags, old.caption, old.notes);
            END;
            CREATE TRIGGER fts_au AFTER UPDATE ON library_images BEGIN
                INSERT INTO library_images_fts(library_images_fts, rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
                VALUES ('delete', old.id, old.filename, old.positive_prompt, old.negative_prompt, old.tags, old.caption, old.notes);
                INSERT INTO library_images_fts(rowid, filename, positive_prompt, negative_prompt, tags, caption, notes)
                VALUES (new.id, new.filename, new.positive_prompt, new.negative_prompt, new.tags, new.caption, new.notes);
            END;
        """)
        conn.execute("INSERT INTO library_images_fts(library_images_fts) VALUES('rebuild')")
        conn.commit()


def _hash_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _image_ext(filename: str, image: Image.Image) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        return suffix
    fmt = (image.format or "").lower()
    if fmt in {"jpeg", "jpg"}:
        return ".jpg"
    if fmt == "webp":
        return ".webp"
    return ".png"


def _save_thumbnail(image: Image.Image, path: Path) -> None:
    thumb = image.convert("RGB").copy()
    thumb.thumbnail((420, 420))
    thumb.save(path, format="JPEG", quality=88)


def _row_to_dict(row: sqlite3.Row, include_embedding: bool = False) -> dict[str, Any]:
    data = dict(row)
    data["tags"] = [t.strip() for t in (data.get("tags") or "").split(",") if t.strip()]
    raw = data.get("raw_metadata") or "{}"
    try:
        data["raw_metadata"] = json.loads(raw)
    except Exception:
        data["raw_metadata"] = {}
    for key in ("file_path", "thumb_path"):
        if data.get(key):
            data[key] = str(_resolve(data[key]))
    if not include_embedding:
        data.pop("embedding", None)
    return data


def register_image(raw: bytes, filename: str, original_path: str = "") -> dict[str, Any]:
    image_hash = _hash_bytes(raw)
    with _connect() as conn:
        existing = conn.execute(
            "SELECT * FROM library_images WHERE sha256 = ?", (image_hash,)
        ).fetchone()
        if existing:
            return _row_to_dict(existing)

        image = Image.open(Path(original_path)) if original_path and Path(original_path).is_file() else Image.open(io.BytesIO(raw))
        image = image.copy()
        ext = _image_ext(filename, image)
        stored_name = f"{image_hash[:16]}{ext}"
        thumb_name = f"{image_hash[:16]}.jpg"
        file_path = _images_dir() / stored_name
        thumb_path = _thumbs_dir() / thumb_name

        with open(file_path, "wb") as f:
            f.write(raw)
        _save_thumbnail(image, thumb_path)

        meta = read_a1111_metadata(image) or read_comfyui_metadata(image) or {}
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM library_images").fetchone()[0]
        now = time.time()
        conn.execute(
            """
            INSERT INTO library_images (
                file_path, thumb_path, original_path, sha256, filename, width, height,
                positive_prompt, negative_prompt, raw_metadata, sort_order,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                str(file_path.relative_to(get_library_root())),
                str(thumb_path.relative_to(get_library_root())),
                original_path,
                image_hash,
                filename,
                image.width,
                image.height,
                meta.get("positive", ""),
                meta.get("negative", ""),
                json.dumps(meta, ensure_ascii=False),
                int(max_order) + 1,
                now,
                now,
            ),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM library_images WHERE sha256 = ?", (image_hash,)).fetchone()
        return _row_to_dict(row)


def _fts_folder_clause(folder_id: int | None) -> tuple[str, list[Any]]:
    if folder_id is None:
        return "", []
    if folder_id == 0:
        return "AND i.folder_id IS NULL", []
    return "AND i.folder_id = ?", [folder_id]


def _fts_list(
    query: str,
    limit: int | None = None,
    offset: int = 0,
    folder_id: int | None = None,
) -> list[dict[str, Any]]:
    tokens = re.findall(r"\w+", query)
    if not tokens:
        return []
    fts_query = " ".join(f'"{t}"' for t in tokens[:20])
    folder_clause, folder_params = _fts_folder_clause(folder_id)
    sql = f"""
        SELECT i.* FROM library_images i
        INNER JOIN library_images_fts ON library_images_fts.rowid = i.id
        WHERE library_images_fts MATCH ?
        {folder_clause}
        ORDER BY rank
    """
    params: list[Any] = [fts_query, *folder_params]
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params.extend([limit, offset])
    with _connect() as conn:
        try:
            rows = conn.execute(sql, params).fetchall()
            return [_row_to_dict(row) for row in rows]
        except Exception:
            return []


def _fts_count(query: str, folder_id: int | None = None) -> int:
    tokens = re.findall(r"\w+", query)
    if not tokens:
        return 0
    fts_query = " ".join(f'"{t}"' for t in tokens[:20])
    folder_clause, folder_params = _fts_folder_clause(folder_id)
    sql = f"""
        SELECT COUNT(*) FROM library_images i
        INNER JOIN library_images_fts ON library_images_fts.rowid = i.id
        WHERE library_images_fts MATCH ?
        {folder_clause}
    """
    params: list[Any] = [fts_query, *folder_params]
    with _connect() as conn:
        try:
            row = conn.execute(sql, params).fetchone()
            return row[0] if row else 0
        except Exception:
            return 0


def list_images(
    query: str = "",
    sort: str = "custom",
    limit: int | None = None,
    offset: int = 0,
    folder_id: int | None = None,
) -> list[dict[str, Any]]:
    if query:
        return _fts_list(query, limit=limit, offset=offset, folder_id=folder_id)

    conditions: list[str] = []
    params: list[Any] = []
    if folder_id is not None:
        if folder_id == 0:
            conditions.append("folder_id IS NULL")
        else:
            conditions.append("folder_id = ?")
            params.append(folder_id)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""

    order_by = {
        "newest": "created_at DESC, id DESC",
        "updated": "updated_at DESC, id DESC",
        "filename": "filename COLLATE NOCASE ASC, id ASC",
    }.get(sort, "sort_order ASC, id ASC")

    sql = f"SELECT * FROM library_images {where} ORDER BY {order_by}"
    if limit is not None:
        sql += " LIMIT ? OFFSET ?"
        params = list(params) + [limit, offset]

    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
        return [_row_to_dict(row) for row in rows]


def count_images(query: str = "", folder_id: int | None = None) -> int:
    if query:
        return _fts_count(query, folder_id=folder_id)

    conditions: list[str] = []
    params: list[Any] = []
    if folder_id is not None:
        if folder_id == 0:
            conditions.append("folder_id IS NULL")
        else:
            conditions.append("folder_id = ?")
            params.append(folder_id)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    with _connect() as conn:
        row = conn.execute(f"SELECT COUNT(*) FROM library_images {where}", params).fetchone()
        return row[0] if row else 0


def rebuild_search_index() -> None:
    with _connect() as conn:
        conn.execute("INSERT INTO library_images_fts(library_images_fts) VALUES('rebuild')")
        conn.commit()


def get_image(image_id: int) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM library_images WHERE id = ?", (image_id,)).fetchone()
        return _row_to_dict(row) if row else None


def update_image(image_id: int, fields: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "positive_prompt",
        "negative_prompt",
        "caption",
        "tags",
        "notes",
    }
    updates: dict[str, Any] = {}
    for key, value in fields.items():
        if key not in allowed:
            continue
        if key == "tags" and isinstance(value, list):
            value = ", ".join(str(v).strip() for v in value if str(v).strip())
        updates[key] = str(value or "")

    if not updates:
        item = get_image(image_id)
        if item is None:
            raise KeyError(image_id)
        return item

    updates["updated_at"] = time.time()
    set_sql = ", ".join(f"{key} = ?" for key in updates)
    values = list(updates.values()) + [image_id]
    try:
        with _connect() as conn:
            conn.execute(f"UPDATE library_images SET {set_sql} WHERE id = ?", values)
            conn.commit()
    except sqlite3.DatabaseError as e:
        if "database disk image is malformed" not in str(e).lower():
            raise
        rebuild_search_index()
        with _connect() as conn:
            conn.execute(f"UPDATE library_images SET {set_sql} WHERE id = ?", values)
            conn.commit()
    item = get_image(image_id)
    if item is None:
        raise KeyError(image_id)
    return item


def move_image(image_id: int, direction: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        row = conn.execute("SELECT id, sort_order FROM library_images WHERE id = ?", (image_id,)).fetchone()
        if row is None:
            raise KeyError(image_id)
        op = "<" if direction == "up" else ">"
        order = "DESC" if direction == "up" else "ASC"
        other = conn.execute(
            f"""
            SELECT id, sort_order FROM library_images
            WHERE sort_order {op} ?
            ORDER BY sort_order {order}, id {order}
            LIMIT 1
            """,
            (row["sort_order"],),
        ).fetchone()
        if other is not None:
            conn.execute("UPDATE library_images SET sort_order = ? WHERE id = ?", (other["sort_order"], row["id"]))
            conn.execute("UPDATE library_images SET sort_order = ? WHERE id = ?", (row["sort_order"], other["id"]))
            conn.commit()
    return list_images()


def reorder_images(image_ids: list[int]) -> list[dict[str, Any]]:
    clean_ids: list[int] = []
    seen: set[int] = set()
    for image_id in image_ids:
        try:
            value = int(image_id)
        except (TypeError, ValueError):
            continue
        if value in seen:
            continue
        seen.add(value)
        clean_ids.append(value)

    if not clean_ids:
        return list_images()

    with _connect() as conn:
        existing_rows = conn.execute(
            "SELECT id FROM library_images ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        existing_ids = [int(row["id"]) for row in existing_rows]
        ordered_ids = [image_id for image_id in clean_ids if image_id in existing_ids]
        ordered_ids.extend(image_id for image_id in existing_ids if image_id not in seen)
        for index, image_id in enumerate(ordered_ids, start=1):
            conn.execute(
                "UPDATE library_images SET sort_order = ? WHERE id = ?",
                (index, image_id),
            )
        conn.commit()
    return list_images()


def reorder_folders(folder_ids: list[int]) -> list[dict[str, Any]]:
    clean_ids: list[int] = []
    seen: set[int] = set()
    for fid in folder_ids:
        try:
            value = int(fid)
        except (TypeError, ValueError):
            continue
        if value in seen:
            continue
        seen.add(value)
        clean_ids.append(value)

    if not clean_ids:
        return list_folders()

    with _connect() as conn:
        for index, fid in enumerate(clean_ids, start=1):
            conn.execute(
                "UPDATE library_folders SET sort_order = ? WHERE id = ?",
                (index, fid),
            )
        conn.commit()
    return list_folders()


def list_folders() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT f.id, f.name, f.sort_order, f.created_at, f.parent_id,
                   COUNT(i.id) AS image_count
            FROM library_folders f
            LEFT JOIN library_images i ON i.folder_id = f.id
            GROUP BY f.id
            ORDER BY f.sort_order ASC, f.id ASC
            """
        ).fetchall()
        return [dict(row) for row in rows]


def create_folder(name: str, parent_id: int | None = None) -> dict[str, Any]:
    now = time.time()
    with _connect() as conn:
        if parent_id is None:
            max_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), 0) FROM library_folders WHERE parent_id IS NULL"
            ).fetchone()[0]
        else:
            max_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), 0) FROM library_folders WHERE parent_id = ?",
                (parent_id,),
            ).fetchone()[0]
        conn.execute(
            "INSERT INTO library_folders (name, sort_order, created_at, parent_id) VALUES (?, ?, ?, ?)",
            (name.strip(), int(max_order) + 1, now, parent_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM library_folders WHERE rowid = last_insert_rowid()"
        ).fetchone()
        return dict(row)


def rename_folder(folder_id: int, name: str) -> dict[str, Any]:
    with _connect() as conn:
        conn.execute(
            "UPDATE library_folders SET name = ? WHERE id = ?",
            (name.strip(), folder_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM library_folders WHERE id = ?", (folder_id,)
        ).fetchone()
        if not row:
            raise KeyError(folder_id)
        return dict(row)


def move_folder(folder_id: int, new_parent_id: int | None) -> dict[str, Any]:
    with _connect() as conn:
        if new_parent_id is not None:
            ancestor = new_parent_id
            while ancestor is not None:
                if ancestor == folder_id:
                    raise ValueError("循環参照になります")
                row = conn.execute(
                    "SELECT parent_id FROM library_folders WHERE id = ?", (ancestor,)
                ).fetchone()
                ancestor = row["parent_id"] if row else None
        conn.execute(
            "UPDATE library_folders SET parent_id = ? WHERE id = ?",
            (new_parent_id, folder_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM library_folders WHERE id = ?", (folder_id,)
        ).fetchone()
        if not row:
            raise KeyError(folder_id)
        return dict(row)


def delete_folder(folder_id: int) -> None:
    with _connect() as conn:
        folder_row = conn.execute(
            "SELECT parent_id FROM library_folders WHERE id = ?", (folder_id,)
        ).fetchone()
        parent_id = folder_row["parent_id"] if folder_row else None
        conn.execute(
            "UPDATE library_folders SET parent_id = ? WHERE parent_id = ?",
            (parent_id, folder_id),
        )
        conn.execute(
            "UPDATE library_images SET folder_id = NULL WHERE folder_id = ?", (folder_id,)
        )
        conn.execute("DELETE FROM library_folders WHERE id = ?", (folder_id,))
        conn.commit()


def set_image_folder(image_id: int, folder_id: int | None) -> dict[str, Any]:
    with _connect() as conn:
        conn.execute(
            "UPDATE library_images SET folder_id = ? WHERE id = ?", (folder_id, image_id)
        )
        conn.commit()
    item = get_image(image_id)
    if item is None:
        raise KeyError(image_id)
    return item


def delete_image(image_id: int) -> None:
    item = get_image(image_id)
    if not item:
        return
    with _connect() as conn:
        conn.execute("DELETE FROM library_images WHERE id = ?", (image_id,))
        conn.commit()
    for key in ("file_path", "thumb_path"):
        try:
            Path(item[key]).unlink()
        except Exception:
            pass


def _embedding_folder_clause(folder_id: int | None) -> tuple[str, list[Any]]:
    if folder_id is None:
        return "", []
    if folder_id == 0:
        return "AND folder_id IS NULL", []
    return "AND folder_id = ?", [folder_id]


def search_by_embedding(
    query_vector: list[float],
    limit: int | None = 5,
    offset: int = 0,
    folder_id: int | None = None,
) -> list[dict[str, Any]]:
    """クエリベクトルとのコサイン類似度でライブラリを検索し、上位 limit 件を返す。"""
    import math
    qnorm = math.sqrt(sum(x * x for x in query_vector))
    if qnorm == 0:
        return []
    folder_clause, folder_params = _embedding_folder_clause(folder_id)
    with _connect() as conn:
        rows = conn.execute(
            f"""
            SELECT * FROM library_images
            WHERE embedding IS NOT NULL AND embedding_dim > 0
            {folder_clause}
            """,
            folder_params,
        ).fetchall()
    if not rows:
        return []
    scored: list[tuple[float, dict[str, Any]]] = []
    for row in rows:
        raw: bytes = row["embedding"]
        if not raw:
            continue
        n = len(raw) // 4
        vec = struct.unpack(f"<{n}f", raw)
        vnorm = math.sqrt(sum(x * x for x in vec))
        if vnorm == 0:
            continue
        dot = sum(a * b for a, b in zip(query_vector, vec))
        scored.append((dot / (qnorm * vnorm), _row_to_dict(row)))
    scored.sort(key=lambda x: x[0], reverse=True)
    items = [item for _, item in scored]
    if limit is None:
        return items[offset:]
    return items[offset:offset + limit]


def count_embedding_candidates(folder_id: int | None = None) -> int:
    folder_clause, folder_params = _embedding_folder_clause(folder_id)
    with _connect() as conn:
        row = conn.execute(
            f"""
            SELECT COUNT(*) FROM library_images
            WHERE embedding IS NOT NULL AND embedding_dim > 0
            {folder_clause}
            """,
            folder_params,
        ).fetchone()
        return row[0] if row else 0


def text_for_embedding(item: dict[str, Any]) -> str:
    parts = [
        f"Filename: {item.get('filename', '')}",
        f"Tags: {', '.join(item.get('tags') or [])}",
        f"Positive prompt: {item.get('positive_prompt', '')}",
        f"Negative prompt: {item.get('negative_prompt', '')}",
        f"Caption: {item.get('caption', '')}",
        f"Notes: {item.get('notes', '')}",
    ]
    return "\n".join(p for p in parts if p.strip())


def _pack_vector(vector: list[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *[float(v) for v in vector])


def save_embedding(image_id: int, vector: list[float], model: str) -> dict[str, Any]:
    with _connect() as conn:
        now = time.time()
        conn.execute(
            """
            UPDATE library_images
            SET embedding = ?, embedding_model = ?, embedding_dim = ?,
                indexed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (_pack_vector(vector), model, len(vector), now, now, image_id),
        )
        conn.commit()
    item = get_image(image_id)
    if item is None:
        raise KeyError(image_id)
    return item


def search_by_fts(
    query_text: str,
    limit: int | None = 15,
    offset: int = 0,
    folder_id: int | None = None,
) -> list[dict[str, Any]]:
    """FTS5 全文検索で上位 limit 件を返す。"""
    return _fts_list(query_text, limit=limit, offset=offset, folder_id=folder_id)


def search_hybrid(
    query_vector: list[float],
    query_text: str,
    limit: int = 5,
    offset: int = 0,
    folder_id: int | None = None,
) -> list[dict[str, Any]]:
    """FTS5 + ベクトル検索の結果を Reciprocal Rank Fusion で統合して返す。"""
    vec_results = search_by_embedding(query_vector, limit=None, folder_id=folder_id)
    fts_results = search_by_fts(query_text, limit=None, folder_id=folder_id)

    vec_ranks = {item["id"]: rank for rank, item in enumerate(vec_results, 1)}
    fts_ranks = {item["id"]: rank for rank, item in enumerate(fts_results, 1)}

    k = 60
    all_ids = set(vec_ranks) | set(fts_ranks)
    scores: list[tuple[float, int]] = []
    for id_ in all_ids:
        score = 0.0
        if id_ in vec_ranks:
            score += 1.0 / (k + vec_ranks[id_])
        if id_ in fts_ranks:
            score += 1.0 / (k + fts_ranks[id_])
        scores.append((score, id_))
    scores.sort(reverse=True)

    id_to_item: dict[int, dict] = {}
    for item in [*vec_results, *fts_results]:
        id_to_item.setdefault(item["id"], item)

    page = scores[offset:offset + limit]
    return [id_to_item[id_] for _, id_ in page if id_ in id_to_item]


def count_hybrid_candidates(
    query_vector: list[float],
    query_text: str,
    folder_id: int | None = None,
) -> int:
    vec_results = search_by_embedding(query_vector, limit=None, folder_id=folder_id)
    fts_results = search_by_fts(query_text, limit=None, folder_id=folder_id)
    return len({item["id"] for item in [*vec_results, *fts_results]})
