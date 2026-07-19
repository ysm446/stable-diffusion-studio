from __future__ import annotations

import io
import json

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse
from PIL import Image

import caption_prompt_store
import chat_prompt_store
import embedding_client
import image_library
import llm_client
import settings_manager
from app_state import _state
from helpers import resolve_default_model_label
from streaming import make_sse_response

router = APIRouter()


# ---------------------------------------------------------------------------
# Library root folder
# ---------------------------------------------------------------------------

def _library_root_info() -> dict:
    configured = (settings_manager.load().get("library_root") or "").strip()
    root = image_library.get_library_root()
    return {
        "root": str(root),
        "configured": configured,
        "is_default": not configured,
        "exists": root.exists(),
    }


@router.get("/api/library/root")
def library_get_root():
    return _library_root_info()


@router.post("/api/library/root")
async def library_set_root(request: Request):
    body = await request.json()
    raw = (body.get("path") or "").strip().strip('"')
    settings = settings_manager.load()
    settings["library_root"] = raw
    settings_manager.save(settings)
    info = _library_root_info()
    # ルート配下のフォルダ／DB を作成し、接続できることを確認する
    try:
        image_library.count_images()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ライブラリを開けませんでした: {e}")
    return {"ok": True, **info}


# ---------------------------------------------------------------------------
# Image library CRUD
# ---------------------------------------------------------------------------

@router.get("/api/library/folders")
def library_list_folders():
    try:
        return {"folders": image_library.list_folders()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/library/folders")
async def library_create_folder(request: Request):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="フォルダ名を指定してください")
    parent_id = body.get("parent_id")
    if parent_id is not None:
        try:
            parent_id = int(parent_id)
        except (ValueError, TypeError):
            parent_id = None
    folder = image_library.create_folder(name, parent_id)
    return {"ok": True, "folder": folder}


@router.patch("/api/library/folders/{folder_id}")
async def library_rename_folder(folder_id: int, request: Request):
    body = await request.json()
    result = None
    if "name" in body:
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="フォルダ名を指定してください")
        try:
            result = image_library.rename_folder(folder_id, name)
        except KeyError:
            raise HTTPException(status_code=404, detail="フォルダが見つかりません")
    if "parent_id" in body:
        parent_id = body.get("parent_id")
        if parent_id is not None:
            try:
                parent_id = int(parent_id)
            except (ValueError, TypeError):
                parent_id = None
        try:
            result = image_library.move_folder(folder_id, parent_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="フォルダが見つかりません")
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
    if result is None:
        raise HTTPException(status_code=400, detail="変更内容がありません")
    return {"ok": True, "folder": result}


@router.post("/api/library/folders/reorder")
async def library_reorder_folders(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids は配列で指定してください")
    image_library.reorder_folders(ids)
    return {"ok": True}


@router.delete("/api/library/folders/{folder_id}")
def library_delete_folder(folder_id: int):
    image_library.delete_folder(folder_id)
    return {"ok": True}


@router.get("/api/library/images")
def library_images(
    q: str = "",
    sort: str = "custom",
    limit: int = 50,
    offset: int = 0,
    folder_id: int | None = None,
    search_mode: str = "fts",
):
    query = q.strip()
    mode = search_mode.strip().lower()
    try:
        if query and mode in {"vector", "hybrid"}:
            vector, _ = embedding_client.embed_text(query)
            if mode == "vector":
                images = image_library.search_by_embedding(
                    vector,
                    limit=limit,
                    offset=offset,
                    folder_id=folder_id,
                )
                total = image_library.count_embedding_candidates(folder_id=folder_id)
            else:
                images = image_library.search_hybrid(
                    vector,
                    query,
                    limit=limit,
                    offset=offset,
                    folder_id=folder_id,
                )
                total = image_library.count_hybrid_candidates(
                    vector,
                    query,
                    folder_id=folder_id,
                )
        else:
            images = image_library.list_images(query=query, sort=sort, limit=limit, offset=offset, folder_id=folder_id)
            total = image_library.count_images(query=query, folder_id=folder_id)
        return {"images": images, "total": total}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/save_current_to_library")
def save_current_to_library():
    image = _state.get("current_image")
    if image is None:
        raise HTTPException(status_code=400, detail="現在表示中の画像がありません")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    raw = buf.getvalue()
    from pathlib import Path
    path = _state.get("current_image_path", "")
    filename = Path(path).name if path else "image.png"
    item = image_library.register_image(raw, filename, path)
    return {"ok": True, "image": item}


@router.post("/api/library/images")
async def library_register_image(file: UploadFile = File(...), image_path: str = Form("")):
    raw = await file.read()
    try:
        item = image_library.register_image(raw, file.filename or "image.png", image_path)
        return {"ok": True, "image": item}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/library/images/reorder")
async def library_reorder_images(request: Request):
    body = await request.json()
    ids = body.get("ids", [])
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="ids は配列で指定してください")
    image_library.reorder_images(ids)
    return {"ok": True}


@router.get("/api/library/images/{image_id}")
def library_get_image(image_id: int):
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    return item


@router.get("/api/library/images/{image_id}/file")
def library_image_file(image_id: int, thumb: int = 0):
    from pathlib import Path
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    path = Path(item["thumb_path"] if thumb else item["file_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="画像ファイルが見つかりません")
    return FileResponse(str(path))


@router.post("/api/library/images/{image_id}/use")
def library_use_image(image_id: int):
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    try:
        image = Image.open(item["file_path"]).copy()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    _state["current_image"] = image
    _state["current_image_path"] = item.get("original_path") or item.get("file_path", "")
    return {
        "ok": True,
        "image": item,
        "meta": {
            "positive": item.get("positive_prompt", ""),
            "negative": item.get("negative_prompt", ""),
            "width": item.get("width"),
            "height": item.get("height"),
            "seed": (item.get("raw_metadata") or {}).get("seed"),
        },
    }


@router.post("/api/library/images/{image_id}")
async def library_update_image(image_id: int, request: Request):
    body = await request.json()
    try:
        return {"ok": True, "image": image_library.update_image(image_id, body)}
    except KeyError:
        raise HTTPException(status_code=404, detail="画像が見つかりません")


@router.post("/api/library/images/{image_id}/move")
async def library_move_image(image_id: int, request: Request):
    body = await request.json()
    direction = body.get("direction", "")
    if direction not in {"up", "down"}:
        raise HTTPException(status_code=400, detail="direction は up/down のどちらかです")
    try:
        image_library.move_image(image_id, direction)
        return {"ok": True}
    except KeyError:
        raise HTTPException(status_code=404, detail="画像が見つかりません")


@router.post("/api/library/images/{image_id}/folder")
async def library_set_image_folder(image_id: int, request: Request):
    body = await request.json()
    folder_id = body.get("folder_id")
    if folder_id is not None:
        folder_id = int(folder_id)
    try:
        return {"ok": True, "image": image_library.set_image_folder(image_id, folder_id)}
    except KeyError:
        raise HTTPException(status_code=404, detail="画像が見つかりません")


@router.delete("/api/library/images/{image_id}")
def library_delete_image(image_id: int):
    image_library.delete_image(image_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Prompt stores
# ---------------------------------------------------------------------------

@router.get("/api/chat_prompts")
def get_chat_prompts():
    return {"prompts": chat_prompt_store.list_prompts()}


@router.post("/api/chat_prompts")
async def save_chat_prompt(request: Request):
    body = await request.json()
    try:
        prompt = chat_prompt_store.save_prompt(body)
        return {"ok": True, "prompt": prompt, "prompts": chat_prompt_store.list_prompts()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/chat_prompts/{prompt_id}")
def delete_chat_prompt(prompt_id: str):
    chat_prompt_store.delete_prompt(prompt_id)
    return {"ok": True, "prompts": chat_prompt_store.list_prompts()}


@router.get("/api/library/caption_prompts")
def library_caption_prompts():
    return {"prompts": caption_prompt_store.list_prompts()}


@router.post("/api/library/caption_prompts")
async def library_save_caption_prompt(request: Request):
    body = await request.json()
    try:
        prompt = caption_prompt_store.save_prompt(body)
        return {"ok": True, "prompt": prompt, "prompts": caption_prompt_store.list_prompts()}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/api/library/caption_prompts/{prompt_id}")
def library_delete_caption_prompt(prompt_id: str):
    caption_prompt_store.delete_prompt(prompt_id)
    return {"ok": True, "prompts": caption_prompt_store.list_prompts()}


# ---------------------------------------------------------------------------
# Caption generation
# ---------------------------------------------------------------------------

def _load_caption_prompt(item: dict, body: dict):
    prompt_id = body.get("caption_prompt_id") or body.get("caption_mode") or "visual"
    return caption_prompt_store.get_prompt(prompt_id) or caption_prompt_store.get_prompt("visual")


def _build_caption_values(item: dict) -> dict:
    return {
        "positive_prompt": item.get("positive_prompt", ""),
        "negative_prompt": item.get("negative_prompt", ""),
        "notes": item.get("notes", ""),
        "filename": item.get("filename", ""),
        "tags": ", ".join(item.get("tags") or []),
    }


def _ensure_model_loaded(model_label: str) -> None:
    if not llm_client.is_loaded():
        label = resolve_default_model_label(model_label)
        if label:
            model_id = llm_client.MODEL_PRESETS.get(label, label)
            llm_client.load_model(model_id)


def _parse_caption_result(text: str) -> tuple[str, list[str] | None]:
    raw = (text or "").strip()
    if not raw:
        return "", None

    candidate = raw
    if candidate.startswith("```"):
        lines = candidate.splitlines()
        if lines and lines[0].strip().startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        candidate = "\n".join(lines).strip()

    start = candidate.find("{")
    end = candidate.rfind("}")
    if start != -1 and end != -1 and start < end:
        candidate = candidate[start : end + 1]

    try:
        data = json.loads(candidate)
    except Exception:
        return raw, None

    if not isinstance(data, dict):
        return raw, None

    caption = str(data.get("caption") or "").strip()
    raw_tags = data.get("tags")
    tags: list[str] = []
    if isinstance(raw_tags, list):
        for tag in raw_tags:
            value = str(tag).strip()
            if value and value not in tags:
                tags.append(value)
    elif isinstance(raw_tags, str):
        for tag in raw_tags.replace("、", ",").split(","):
            value = tag.strip()
            if value and value not in tags:
                tags.append(value)

    return caption or raw, tags[:20]


def _caption_update_fields(generated_text: str) -> dict:
    caption, tags = _parse_caption_result(generated_text)
    fields: dict = {"caption": caption}
    if tags is not None:
        fields["tags"] = tags
    return fields


def _reindex_library_item(item: dict) -> dict:
    text = image_library.text_for_embedding(item)
    if not text.strip():
        raise ValueError("embedding target text is empty")
    vector, model_name = embedding_client.embed_text(text)
    return image_library.save_embedding(item["id"], vector, model_name)


@router.post("/api/library/images/{image_id}/caption")
async def library_caption_image(image_id: int, request: Request):
    body = await request.json()
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    try:
        _ensure_model_loaded(body.get("model_label", ""))
        image = Image.open(item["file_path"]).copy()
        prompt = _load_caption_prompt(item, body)
        if not prompt:
            raise RuntimeError("Caption プロンプトが見つかりません")
        values = _build_caption_values(item)
        system_prompt = caption_prompt_store.render_template(prompt.get("system_prompt", ""), values)
        user_prompt = caption_prompt_store.render_template(prompt.get("user_prompt", ""), values)
        caption = "".join(llm_client.generate_library_caption_stream(
            image=image,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        )).strip()
        updated = image_library.update_image(image_id, _caption_update_fields(caption))
        return {"ok": True, "caption": updated.get("caption", ""), "tags": updated.get("tags", []), "image": updated}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/library/images/{image_id}/caption/stream")
async def library_caption_image_stream(image_id: int, request: Request):
    body = await request.json()
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")

    def worker(send):
        _ensure_model_loaded(body.get("model_label", ""))
        image = Image.open(item["file_path"]).copy()
        prompt = caption_prompt_store.get_prompt(body.get("caption_prompt_id") or "visual") \
            or caption_prompt_store.get_prompt("visual")
        if not prompt:
            send({"type": "error", "content": "Caption プロンプトが見つかりません"})
            return
        values = _build_caption_values(item)
        system_prompt = caption_prompt_store.render_template(prompt.get("system_prompt", ""), values)
        user_prompt = caption_prompt_store.render_template(prompt.get("user_prompt", ""), values)
        full_caption = ""
        for token in llm_client.generate_library_caption_stream(
            image=image,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
        ):
            full_caption += token
            send({"type": "token", "content": token})
        updated = image_library.update_image(image_id, _caption_update_fields(full_caption.strip()))
        send({"type": "done", "image": updated})

    return make_sse_response(worker)


@router.post("/api/library/batch_caption/stream")
async def library_batch_caption_stream(request: Request):
    body = await request.json()
    caption_prompt_id = body.get("caption_prompt_id", "visual")
    skip_existing = bool(body.get("skip_existing", True))
    reindex_after = bool(body.get("reindex_after", False))

    all_items = image_library.list_images()
    items = [i for i in all_items if not (i.get("caption") or "").strip()] if skip_existing else all_items

    def worker(send):
        prompt = caption_prompt_store.get_prompt(caption_prompt_id) \
            or caption_prompt_store.get_prompt("visual")
        if not prompt:
            send({"type": "error", "content": "Caption プロンプトが見つかりません"})
            return
        _ensure_model_loaded("")
        total = len(items)
        done_count = 0
        for idx, item in enumerate(items):
            send({
                "type": "progress",
                "current": idx + 1,
                "total": total,
                "filename": item.get("filename", ""),
                "image_id": item["id"],
            })
            try:
                image = Image.open(item["file_path"]).copy()
                values = _build_caption_values(item)
                sys_prompt = caption_prompt_store.render_template(prompt.get("system_prompt", ""), values)
                usr_prompt = caption_prompt_store.render_template(prompt.get("user_prompt", ""), values)
                caption = "".join(llm_client.generate_library_caption_stream(
                    image=image,
                    system_prompt=sys_prompt,
                    user_prompt=usr_prompt,
                )).strip()
                updated = image_library.update_image(item["id"], _caption_update_fields(caption))
                if reindex_after:
                    send({
                        "type": "reindex_progress",
                        "current": idx + 1,
                        "total": total,
                        "filename": item.get("filename", ""),
                        "image_id": item["id"],
                    })
                    _reindex_library_item(updated)
                done_count += 1
            except Exception as e:
                send({"type": "item_error", "filename": item.get("filename", ""), "content": str(e)})
        send({"type": "done", "count": done_count, "total": total})

    return make_sse_response(worker)


# ---------------------------------------------------------------------------
# Embedding / reindex
# ---------------------------------------------------------------------------

@router.post("/api/library/images/{image_id}/reindex")
def library_reindex_image(image_id: int):
    item = image_library.get_image(image_id)
    if not item:
        raise HTTPException(status_code=404, detail="画像が見つかりません")
    text = image_library.text_for_embedding(item)
    if not text.strip():
        raise HTTPException(status_code=400, detail="embedding 対象のテキストがありません")
    try:
        updated = _reindex_library_item(item)
        return {
            "ok": True,
            "message": "再インデックス化しました",
            "image": updated,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/api/library/batch_reindex/stream")
async def library_batch_reindex_stream(request: Request):
    body = await request.json()
    only_missing = bool(body.get("only_missing", False))

    all_items = image_library.list_images()
    items = [
        item for item in all_items
        if not only_missing or not item.get("embedding_dim")
    ]

    def worker(send):
        total = len(items)
        done_count = 0
        for idx, item in enumerate(items):
            send({
                "type": "progress",
                "current": idx + 1,
                "total": total,
                "filename": item.get("filename", ""),
                "image_id": item["id"],
            })
            try:
                _reindex_library_item(item)
                done_count += 1
            except Exception as e:
                send({"type": "item_error", "filename": item.get("filename", ""), "content": str(e)})
        send({"type": "done", "count": done_count, "total": total})

    return make_sse_response(worker)


@router.get("/api/library/embedding_status")
def library_embedding_status():
    try:
        return embedding_client.status()
    except Exception as e:
        return {"enabled": True, "ready": False, "error": str(e)}
