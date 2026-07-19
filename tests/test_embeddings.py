"""embedding インデックスとベクトル / ハイブリッド検索のスモークテスト。

embedding サーバーは起動せず、決定的なフェイクベクトルで検証する。
実行: python tests/test_embeddings.py
"""

from __future__ import annotations

import io
import os
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

TMP_ROOT = Path(tempfile.mkdtemp(prefix="studio-emb-test-"))
os.environ["STUDIO_LIBRARY_ROOT"] = str(TMP_ROOT)

from PIL import Image

from server.library import embeddings, folders, index_db, items

WORDS = ["cat", "dog", "sunset", "ocean"]


def fake_embed(text: str) -> tuple[list[float], str]:
    low = text.lower()
    vec = [float(low.count(w)) for w in WORDS] + [1.0]
    return vec, "fake-model"


def make_png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 10, 10)).save(buf, "PNG")
    return buf.getvalue()


def main() -> None:
    folders.create_folder("", "a")
    cat = items.create_item("a", make_png(), prompt="a cute cat sitting on grass")
    dog = items.create_item("a", make_png(), prompt="a dog running at sunset beach")
    sea = items.create_item("a", make_png(), prompt="ocean waves at sunset, golden sky")
    empty = items.create_item("a", make_png())  # プロンプトなし → embedding 対象外

    # --- 差分更新 ---
    statuses: list[str] = []
    st = embeddings.embedding_status()
    assert st["total"] == 4 and st["embedded"] == 0 and st["pending"] == 3
    count = embeddings.rebuild_embeddings(fake_embed, statuses.append)
    assert count == 3
    st = embeddings.embedding_status()
    assert st["embedded"] == 3 and st["pending"] == 0

    # 2回目は何もしない
    assert embeddings.rebuild_embeddings(fake_embed, statuses.append) == 0

    # プロンプト変更 → そのアイテムだけ再計算
    items.update_item(cat["id"], {"prompt": "a cute cat and a dog playing"})
    assert embeddings.embedding_status()["pending"] == 1
    assert embeddings.rebuild_embeddings(fake_embed, statuses.append) == 1

    # --- ベクトル検索 ---
    qvec, _ = fake_embed("cat")
    rows = embeddings.search_by_vector(qvec, "a")
    assert rows[0]["id"] == cat["id"], [r["id"] for r in rows]
    assert rows[0]["score"] > 0

    qvec, _ = fake_embed("sunset ocean")
    rows = embeddings.search_by_vector(qvec, "a")
    assert rows[0]["id"] == sea["id"]

    # --- ハイブリッド（RRF） ---
    qvec, _ = fake_embed("sunset")
    rows = embeddings.search_hybrid("sunset", qvec, "a")
    ids = [r["id"] for r in rows]
    assert dog["id"] in ids and sea["id"] in ids
    assert empty["id"] not in ids

    # --- API レベル: フォールバックと similar ---
    from server.generation import embedding_client
    from server.routes import generation as gen_routes
    from server.routes import library as lib_routes

    def boom(text):
        raise RuntimeError("no embedding server")

    orig = embedding_client.embed_text
    embedding_client.embed_text = boom
    try:
        res = lib_routes.list_items(folder="a", q="sunset", search_mode="vector")
        assert "note" in res and len(res["items"]) > 0  # FTS フォールバック
        sim = gen_routes.similar_prompts("sunset", limit=5)
        assert sim["mode"] == "keyword" and len(sim["items"]) > 0
    finally:
        embedding_client.embed_text = orig

    embedding_client.embed_text = fake_embed
    try:
        sim = gen_routes.similar_prompts("cat", limit=5)
        assert sim["mode"] == "hybrid"
        assert sim["items"][0]["id"] == cat["id"]
        res = lib_routes.list_items(folder="a", q="cat", search_mode="hybrid")
        assert "note" not in res and res["items"][0]["id"] == cat["id"]
    finally:
        embedding_client.embed_text = orig

    # --- 削除で embedding も消える ---
    items.delete_item(cat["id"])
    conn = index_db.connect()
    try:
        left = conn.execute(
            "SELECT COUNT(*) FROM item_embeddings WHERE item_id = ?", (cat["id"],)
        ).fetchone()[0]
    finally:
        conn.close()
    assert left == 0

    print("ALL OK")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(TMP_ROOT, ignore_errors=True)
