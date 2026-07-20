"""LLM（llama-server）API。動画プロンプト生成に使う。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from PIL import Image

from server import settings
from server.generation import llm_client
from server.library import items
from server.streaming import make_sse_response

router = APIRouter(prefix="/api/llm")


def _remember_model(model: str) -> None:
    try:
        settings.update({"llm_model": model})
    except Exception:
        pass


def _preferred_model(presets: dict) -> str:
    """前回ロードしたモデル → 先頭のモデル、の順で既定を選ぶ。"""
    last = str(settings.load().get("llm_model") or "").strip()
    if last and last in presets:
        return last
    return next(iter(sorted(presets.keys())), "")


@router.get("/models")
def list_models() -> dict[str, Any]:
    presets = llm_client.refresh_model_presets()
    status = llm_client.get_status()
    return {
        "models": sorted(presets.keys()),
        "loaded": status.get("model") if status.get("ready") else None,
        "ready": status.get("ready", False),
        "last": _preferred_model(presets),
    }


@router.post("/load")
async def load_model(request: Request) -> dict[str, Any]:
    body = await request.json()
    model = (body.get("model") or "").strip()
    if not model:
        raise HTTPException(status_code=400, detail="model が指定されていません")
    try:
        msg = llm_client.load_model(model)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    _remember_model(model)
    return {"ok": True, "message": msg, "loaded": model}


@router.post("/unload")
def unload_model() -> dict[str, Any]:
    return {"ok": True, "message": llm_client.unload_model()}


# 動画プロンプト生成の system プロンプト（旧 Image Assistant より）
_VIDEO_SYSTEM_PROMPT = """\
あなたは画像から動画（image-to-video）を生成するためのプロンプトエンジニアです。
提供された画像・画像プロンプト・追加指示を元に、動画生成用のプロンプトを1つ書いてください。

現在の画像プロンプト: {image_prompt}

ルール:
- 出力は動画プロンプト本文のみ（前置き・見出し・コメント・引用符は不要）
- 英語で、1段落・簡潔かつ具体的に書く
- 静止画に「どんな動き・変化・カメラワークを加えるか」を中心に描写する
  （被写体の動作、髪や布・光の揺らぎ、カメラのパン/ズーム/ドリー等）
- 追加指示があれば最優先で反映する
"""


@router.post("/video-prompt")
async def video_prompt(request: Request):
    body = await request.json()
    item_id = body.get("item_id", "")
    extra = (body.get("extra_instruction") or "").strip()
    requested_model = (body.get("model") or "").strip()

    try:
        meta = items.get_item(item_id)
        d = items.item_dir(item_id)
        image = Image.open(d / meta["image"]).copy()
    except items.NotFound:
        raise HTTPException(status_code=404, detail="画像が見つかりません")

    image_prompt = meta.get("prompt") or ""
    system_content = _VIDEO_SYSTEM_PROMPT.format(image_prompt=image_prompt or "（なし）")
    user_text = (
        f"追加指示: {extra}\n\n動画プロンプトを生成してください。"
        if extra
        else "動画プロンプトを生成してください。"
    )

    def worker(send) -> None:
        # 未ロードなら自動ロード（指定モデル → 前回モデル → 先頭）
        if not llm_client.is_loaded():
            presets = llm_client.refresh_model_presets()
            target = requested_model if requested_model in presets else _preferred_model(presets)
            if not target:
                send({"type": "error", "content": "models/ フォルダに GGUF モデルが見つかりません。"})
                send({"type": "done"})
                return
            try:
                send({"type": "status", "content": f"LLM モデルをロード中: {target} ..."})
                llm_client.load_model(target)
                _remember_model(target)
                send({"type": "model_loaded", "content": target})
            except Exception as e:
                send({"type": "error", "content": f"モデルのロードに失敗しました: {e}"})
                send({"type": "done"})
                return
        try:
            has_vision = llm_client._current_has_vision()
            messages = [
                {"role": "system", "content": system_content},
                {
                    "role": "user",
                    "content": llm_client._to_content_blocks(
                        user_text, image, include_image=has_vision
                    ),
                },
            ]
            for token in llm_client._filter_thinking(
                llm_client._stream_chat(messages, max_tokens=1024)
            ):
                send({"type": "token", "content": token})
            send({"type": "done_prompt"})
        except Exception as e:
            send({"type": "error", "content": f"生成エラー: {e}"})
        finally:
            send({"type": "done"})

    return make_sse_response(worker)
