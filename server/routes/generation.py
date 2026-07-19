"""生成 API（SSE ストリーミング）。

イベント形式:
- {"type": "status", "content": "..."}
- {"type": "item", "item": {...}}    画像生成完了（保存済みアイテム）
- {"type": "video", "item": {...}}   動画生成完了（動画が追加されたアイテム）
- {"type": "error", "content": "..."}
- {"type": "done"}
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request

from server.generation import comfy_client, forge_client, service
from server.streaming import make_sse_response

router = APIRouter(prefix="/api/generation")


@router.get("/options")
def get_options() -> dict[str, Any]:
    comfy_client.reload_workflows()
    return {
        "backends": ["WebUI Forge", "ComfyUI"],
        "forge_samplers": forge_client.get_samplers(),
        "image_workflows": sorted(comfy_client.IMAGE_WORKFLOW_PRESETS.keys()),
        "video_workflows": sorted(comfy_client.VIDEO_WORKFLOW_PRESETS.keys()),
    }


@router.post("/image")
async def generate_image(request: Request):
    params = await request.json()

    def worker(send) -> None:
        start = time.time()
        try:
            item = service.generate_image_to_item(
                params, lambda text: send({"type": "status", "content": text})
            )
            send({
                "type": "item",
                "item": item,
                "status": f"画像を生成しました（{time.time() - start:.1f}秒）",
            })
        except Exception as e:
            send({"type": "error", "content": f"画像生成エラー: {e}"})
        finally:
            send({"type": "done"})

    return make_sse_response(worker)


@router.post("/video")
async def generate_video(request: Request):
    params = await request.json()

    def worker(send) -> None:
        start = time.time()
        try:
            item = service.generate_video_for_item(
                params, lambda text: send({"type": "status", "content": text})
            )
            send({
                "type": "video",
                "item": item,
                "status": f"動画を生成しました（{time.time() - start:.0f}秒）",
            })
        except Exception as e:
            send({"type": "error", "content": f"動画生成エラー: {e}"})
        finally:
            send({"type": "done"})

    return make_sse_response(worker)


@router.post("/interrupt")
def interrupt() -> dict[str, bool]:
    comfy_client.interrupt()
    return {"ok": True}


@router.get("/similar")
def similar_prompts(q: str, limit: int = 5) -> dict[str, Any]:
    """ライブラリから類似プロンプトを返す（旧 {library_context} 相当）。

    embedding サーバーが使えればハイブリッド検索、なければ FTS5 のみ。
    """
    from server.library import embeddings, index_db

    query = q.strip()
    if not query:
        return {"items": [], "mode": "none"}
    mode = "hybrid"
    try:
        from server.generation import embedding_client

        vector, _model = embedding_client.embed_text(query)
        rows = embeddings.search_hybrid(query, vector, limit=limit)
    except Exception:
        mode = "keyword"
        rows = index_db.search_items(query, "")[:limit]
    items = [
        {
            "id": r["id"],
            "folder": r.get("folder", ""),
            "thumb": r.get("thumb"),
            "prompt": r.get("prompt", ""),
            "negative_prompt": r.get("negative_prompt", ""),
            "caption": r.get("caption", ""),
        }
        for r in rows
        if (r.get("prompt") or "").strip()
    ]
    return {"items": items, "mode": mode}
