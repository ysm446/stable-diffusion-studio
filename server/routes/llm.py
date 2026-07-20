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


# 動画プロンプト生成のセクションテンプレートと system プロンプト（旧 Image Assistant より）
_SECTION_TEMPLATES = {
    "scene": "**Scene**: [Describe the visual scene in detail based on the image]",
    "action": "**Action**: [Describe the motion/movement to add - be specific about what moves and how]",
    "camera": "**Camera**: [Describe camera movement: static, slow pan, zoom in/out, dolly, tracking, etc.]",
    "style": "**Style**: [Describe the visual style and mood]",
    "prompt": (
        "---\n**Final Prompt for WAN 2.2**:\n"
        "[Write a single paragraph combining all elements. "
        "This should be copy-paste ready for WAN 2.2. "
        "Write in English, be concise but descriptive. "
        "Focus on motion and cinematic qualities.]"
    ),
}
ALL_SECTIONS = list(_SECTION_TEMPLATES.keys())

_VIDEO_SYSTEM_PROMPT_TEMPLATE = """\
あなたはWan2.2動画生成のプロンプトエンジニアリングの専門家です。
提供された画像・画像プロンプト・追加指示を元に、以下のセクションを順番に出力してください。

現在の画像プロンプト: {positive_prompt}

出力するセクション（指定されたものだけ出力してください）:
{sections_text}

ルール:
- 指定されたセクションのみを出力してください（他のセクション・前置き・コメント不要）
- 各セクションは簡潔に1-2文で書いてください。
- 英語で記述してください
- 動きや変化・雰囲気を具体的に記述してください
"""


@router.post("/video-prompt")
async def video_prompt(request: Request):
    body = await request.json()
    item_id = body.get("item_id", "")
    extra = (body.get("extra_instruction") or "").strip()
    requested_model = (body.get("model") or "").strip()
    sections = body.get("sections") or ALL_SECTIONS
    # 指定順序ではなく定義順で、選択されたものだけ
    active = [s for s in ALL_SECTIONS if s in sections]
    if not active:
        raise HTTPException(status_code=400, detail="セクションを1つ以上選択してください")

    try:
        meta = items.get_item(item_id)
        d = items.item_dir(item_id)
        image = Image.open(d / meta["image"]).copy()
    except items.NotFound:
        raise HTTPException(status_code=404, detail="画像が見つかりません")

    image_prompt = meta.get("prompt") or ""
    sections_text = "\n".join(_SECTION_TEMPLATES[name] for name in active)
    system_content = _VIDEO_SYSTEM_PROMPT_TEMPLATE.format(
        positive_prompt=image_prompt or "（なし）",
        sections_text=sections_text,
    )
    user_text = f"追加指示: {extra}\n\n動画プロンプトを生成してください。"

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
