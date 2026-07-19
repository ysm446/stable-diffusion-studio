from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

import chat_prompt_store
import llm_client
from app_state import _state
from helpers import build_library_context, resolve_default_model_label
from prompt_parser import parse_prompt_update
from streaming import make_sse_response, sse_event

router = APIRouter()


# ---------------------------------------------------------------------------
# Chat
# ---------------------------------------------------------------------------

@router.post("/api/chat/stream")
async def chat_stream(request: Request):
    body = await request.json()
    user_input = body.get("user_input", "").strip()
    model_label = body.get("model_label", "")
    positive = body.get("positive", "")
    negative = body.get("negative", "")
    chat_prompt_id = body.get("chat_prompt_id", "review")
    library_context_limit = max(1, min(20, int(body.get("library_context_limit", 5))))
    library_search_mode = body.get("library_search_mode", "vector")
    chat_max_tokens = int(body.get("max_tokens", 0)) or None

    _cp = chat_prompt_store.get_prompt(chat_prompt_id) or chat_prompt_store.get_prompt("review")
    _system_template = (_cp or {}).get("system_prompt", "") if _cp else ""

    if not user_input:
        async def empty():
            yield sse_event({"type": "done"})
        return StreamingResponse(empty(), media_type="text/event-stream")

    _state["positive_prompt"] = positive
    _state["negative_prompt"] = negative

    def worker(send):
        template_vars: dict = {"positive_prompt": positive, "negative_prompt": negative}
        if "{library_context}" in _system_template:
            template_vars["library_context"] = build_library_context(
                user_input, limit=library_context_limit, search_mode=library_search_mode
            )
        rendered_system = chat_prompt_store.render_template(_system_template, template_vars) if _cp else None

        if not llm_client.is_loaded():
            label = resolve_default_model_label(model_label)
            model_id = llm_client.MODEL_PRESETS.get(label, label)
            try:
                msg = llm_client.load_model(model_id)
                send({"type": "model_loaded", "message": msg})
            except RuntimeError as e:
                send({"type": "error", "content": f"モデルロード失敗: {e}"})
                return

        partial = ""
        for token in llm_client.query_stream(
            conversation_history=_state["conversation_history"],
            user_input=user_input,
            current_image=_state.get("current_image"),
            positive_prompt=positive,
            negative_prompt=negative,
            system_prompt=rendered_system,
            max_tokens=chat_max_tokens,
        ):
            partial += token
            send({"type": "token", "content": token})

        usage = llm_client.get_last_usage()
        if usage:
            send({
                "type": "context_usage",
                "prompt_tokens": usage.get("prompt_tokens", 0),
                "completion_tokens": usage.get("completion_tokens", 0),
                "total_tokens": usage.get("total_tokens", 0),
                "n_ctx": llm_client._DEFAULT_N_CTX,
            })

        positive_new, negative_new, display_text = parse_prompt_update(partial)
        _state["conversation_history"].append({
            "role": "user",
            "content": [{"type": "text", "text": user_input}],
        })
        _state["conversation_history"].append({
            "role": "assistant",
            "content": partial,
        })
        send({
            "type": "done",
            "positive": positive_new,
            "negative": negative_new,
            "display_text": display_text,
        })

    return make_sse_response(worker)


@router.post("/api/chat/clear")
def chat_clear():
    _state["conversation_history"] = []
    return {"ok": True}


# ---------------------------------------------------------------------------
# Video prompt generation
# ---------------------------------------------------------------------------

@router.post("/api/video_prompt/stream")
async def video_prompt_stream(request: Request):
    body = await request.json()
    positive = body.get("positive", "")
    extra_instruction = body.get("extra_instruction", "")
    sections = body.get("sections", [])
    model_label = body.get("model_label", "")

    if not sections:
        async def err():
            yield sse_event({"type": "error", "content": "セクションを1つ以上選択してください"})
        return StreamingResponse(err(), media_type="text/event-stream")

    def worker(send):
        if not llm_client.is_loaded():
            label = resolve_default_model_label(model_label)
            model_id = llm_client.MODEL_PRESETS.get(label, label)
            send({"type": "status", "content": "モデルをロード中..."})
            try:
                llm_client.load_model(model_id)
            except RuntimeError as e:
                send({"type": "error", "content": f"モデルロード失敗: {e}"})
                return

        for token in llm_client.generate_video_prompt_stream(
            image=_state.get("video_input_image"),
            positive_prompt=positive,
            extra_instruction=extra_instruction,
            sections=sections,
        ):
            send({"type": "token", "content": token})

        send({"type": "done"})

    return make_sse_response(worker)
