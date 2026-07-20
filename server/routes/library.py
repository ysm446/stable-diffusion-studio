"""ライブラリ API。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server import settings
from server.library import embeddings, folders, index_db, items, paths
from server.streaming import make_sse_response

router = APIRouter(prefix="/api/library")


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except items.NotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (items.LibraryError, folders.FolderError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"ファイル操作に失敗しました: {e}")


# ---------------------------------------------------------------------------
# ライブラリルート
# ---------------------------------------------------------------------------


class RootUpdate(BaseModel):
    path: str = ""  # 空文字で既定（data/library）に戻す


@router.get("/root")
def get_root() -> dict[str, Any]:
    configured = str(settings.load().get("library_root") or "").strip()
    return {
        "root": str(paths.get_library_root()),
        "configured": configured,
        "default": str(paths.DEFAULT_LIBRARY_DIR),
    }


@router.post("/root")
def set_root(body: RootUpdate) -> dict[str, Any]:
    raw = body.path.strip()
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            raise HTTPException(status_code=400, detail="絶対パスを指定してください")
        if p.exists() and not p.is_dir():
            raise HTTPException(status_code=400, detail="フォルダではありません")
        try:
            p.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise HTTPException(status_code=400, detail=f"フォルダを作成できません: {e}")
        settings.update({"library_root": str(p)})
    else:
        settings.update({"library_root": ""})
    count = index_db.rebuild()
    return {"root": str(paths.get_library_root()), "indexed": count}


# ---------------------------------------------------------------------------
# フォルダ
# ---------------------------------------------------------------------------


class FolderCreate(BaseModel):
    parent: str = ""
    name: str


class FolderRename(BaseModel):
    rel: str
    new_name: str


class FolderMove(BaseModel):
    rel: str
    dest_parent: str = ""


@router.get("/tree")
def get_tree() -> dict[str, Any]:
    return folders.tree()


@router.post("/folders")
def create_folder(body: FolderCreate) -> dict[str, str]:
    rel = _wrap(folders.create_folder, body.parent, body.name)
    return {"rel": rel}


@router.post("/folders/rename")
def rename_folder(body: FolderRename) -> dict[str, str]:
    rel = _wrap(folders.rename_folder, body.rel, body.new_name)
    return {"rel": rel}


@router.post("/folders/move")
def move_folder(body: FolderMove) -> dict[str, str]:
    rel = _wrap(folders.move_folder, body.rel, body.dest_parent)
    return {"rel": rel}


@router.delete("/folders")
def delete_folder(rel: str, recursive: bool = False) -> dict[str, bool]:
    _wrap(folders.delete_folder, rel, recursive=recursive)
    return {"ok": True}


class FolderReveal(BaseModel):
    rel: str = ""


@router.post("/folders/reveal")
def reveal_folder(body: FolderReveal) -> dict[str, bool]:
    """フォルダをエクスプローラーで開く。"""
    import os
    import subprocess

    target = _wrap(paths.resolve_rel, body.rel)
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="folder not found")
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="Windows のみ対応しています")
    subprocess.Popen(["explorer", str(target)])
    return {"ok": True}


# ---------------------------------------------------------------------------
# アイテム
# ---------------------------------------------------------------------------


class ItemUpdate(BaseModel):
    prompt: str | None = None
    negative_prompt: str | None = None
    caption: str | None = None
    seed: int | None = None
    params: dict[str, Any] | None = None
    tags: list[str] | None = None


class ItemMove(BaseModel):
    folder: str = ""


class ItemReorder(BaseModel):
    folder: str = ""
    order: list[str]


@router.get("/items")
def list_items(
    folder: str = "",
    recursive: bool = False,
    q: str = "",
    search_mode: str = "keyword",
) -> dict[str, Any]:
    folder = _wrap(paths.normalize_rel, folder)
    query = q.strip()
    if not query:
        return {"items": index_db.list_items(folder, recursive)}

    note = ""
    rows: list[dict[str, Any]] = []
    if search_mode in ("vector", "hybrid"):
        try:
            from server.generation import embedding_client

            vector, _model = embedding_client.embed_text(query)
            if search_mode == "vector":
                rows = embeddings.search_by_vector(vector, folder, limit=100)
            else:
                rows = embeddings.search_hybrid(query, vector, folder, limit=100)
        except Exception as e:
            note = f"ベクトル検索が使えないためキーワード検索にフォールバックしました: {e}"
            rows = index_db.search_items(query, folder)
    else:
        rows = index_db.search_items(query, folder)
    result: dict[str, Any] = {"items": rows}
    if note:
        result["note"] = note
    return result


@router.get("/items/{item_id}")
def get_item(item_id: str) -> dict[str, Any]:
    return _wrap(items.get_item, item_id)


@router.post("/items/import")
async def import_image(folder: str = Form(""), file: UploadFile | None = None) -> dict[str, Any]:
    if file is None:
        raise HTTPException(status_code=400, detail="file is required")
    data = await file.read()
    return _wrap(items.import_image, folder, data, file.filename or "")


@router.patch("/items/{item_id}")
def update_item(item_id: str, body: ItemUpdate) -> dict[str, Any]:
    # リクエストで明示的に指定されたフィールドのみ更新（seed=null でクリア可）
    fields = body.model_dump(exclude_unset=True)
    return _wrap(items.update_item, item_id, fields)


@router.post("/items/{item_id}/move")
def move_item(item_id: str, body: ItemMove) -> dict[str, Any]:
    return _wrap(items.move_item, item_id, body.folder)


@router.post("/items/reorder")
def reorder_items(body: ItemReorder) -> dict[str, bool]:
    _wrap(items.reorder, body.folder, body.order)
    return {"ok": True}


@router.delete("/items/{item_id}")
def delete_item(item_id: str) -> dict[str, bool]:
    _wrap(items.delete_item, item_id)
    return {"ok": True}


@router.post("/items/{item_id}/reveal")
def reveal_item(item_id: str) -> dict[str, bool]:
    """アイテムの画像ファイルをエクスプローラーで選択表示する。"""
    import os
    import subprocess

    d = _wrap(items.item_dir, item_id)
    meta = _wrap(items.get_item, item_id)
    target = d / (meta.get("image") or "image.png")
    if not target.is_file():
        target = d
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="Windows のみ対応しています")
    if target.is_dir():
        subprocess.Popen(["explorer", str(target)])
    else:
        subprocess.Popen(["explorer", "/select,", str(target)])
    return {"ok": True}


# ---------------------------------------------------------------------------
# 動画
# ---------------------------------------------------------------------------


@router.post("/items/{item_id}/videos")
async def add_video(
    item_id: str,
    file: UploadFile | None = None,
    prompt: str = Form(""),
    workflow: str = Form(""),
    probe: bool = Form(False),
) -> dict[str, Any]:
    if file is None:
        raise HTTPException(status_code=400, detail="file is required")
    filename = file.filename or ""
    ext = Path(filename).suffix.lower()
    if ext not in (".mp4", ".webm", ".avi", ".mov", ".mkv"):
        raise HTTPException(status_code=400, detail=f"未対応の動画形式です: {ext or '(不明)'}")
    data = await file.read()

    settings: dict[str, Any] = {}
    # 取り込み時は ffprobe でメタデータ（解像度・fps・尺・埋め込みプロンプト）を抽出
    if probe:
        from server.library import video_import

        info = video_import.probe(data, ext=ext)
        settings = info["settings"]
        settings["source_filename"] = filename
        if not prompt and info["prompt"]:
            prompt = info["prompt"]

    return _wrap(
        items.add_video,
        item_id,
        data,
        ext=ext,
        prompt=prompt,
        workflow=workflow,
        settings=settings or None,
    )


class VideoUpdate(BaseModel):
    prompt: str | None = None
    workflow: str | None = None
    settings: dict[str, Any] | None = None


@router.patch("/items/{item_id}/videos/{file_name}")
def update_video(item_id: str, file_name: str, body: VideoUpdate) -> dict[str, Any]:
    fields = body.model_dump(exclude_unset=True)
    return _wrap(items.update_video, item_id, file_name, fields)


@router.delete("/items/{item_id}/videos/{file_name}")
def remove_video(item_id: str, file_name: str) -> dict[str, Any]:
    return _wrap(items.remove_video, item_id, file_name)


# ---------------------------------------------------------------------------
# ファイル配信・インデックス
# ---------------------------------------------------------------------------


@router.get("/file/{item_id}/{name:path}")
def get_file(item_id: str, name: str):
    d = _wrap(items.item_dir, item_id)
    target = (d / name).resolve()
    if d.resolve() not in target.parents:
        raise HTTPException(status_code=400, detail="invalid file path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(target))


@router.get("/videos")
def list_all_videos() -> dict[str, Any]:
    return {"videos": index_db.list_all_videos()}


@router.post("/reindex")
def reindex() -> dict[str, int]:
    count = index_db.rebuild()
    return {"count": count}


@router.get("/embeddings/status")
def embeddings_status() -> dict[str, Any]:
    return embeddings.embedding_status()


@router.post("/embeddings/rebuild")
async def embeddings_rebuild():
    def worker(send) -> None:
        try:
            from server.generation import embedding_client

            send({"type": "status", "content": "embedding サーバーを確認中..."})
            count = embeddings.rebuild_embeddings(
                embedding_client.embed_text,
                lambda text: send({"type": "status", "content": text}),
            )
            send({
                "type": "result",
                "count": count,
                "status": f"embedding を更新しました（{count} 件）",
            })
        except Exception as e:
            send({"type": "error", "content": f"embedding 更新エラー: {e}"})
        finally:
            send({"type": "done"})

    return make_sse_response(worker)
