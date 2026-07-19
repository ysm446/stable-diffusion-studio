from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from PIL import Image

import a1111_client
import comfy_process
import comfyui_client
import llm_client
import sd_process
from app_state import _state, _temp_files, next_video_gen_id, current_video_gen_id
from helpers import (
    image_to_b64,
    get_next_seq,
    build_pnginfo,
    run_in_thread,
)
from prompt_parser import read_a1111_metadata, read_comfyui_metadata
from streaming import sse_event

router = APIRouter()


# ---------------------------------------------------------------------------
# File serving
# ---------------------------------------------------------------------------

@router.get("/api/file/{token}")
def serve_file(token: str):
    path = _temp_files.get(token)
    if not path or not os.path.isfile(path):
        raise HTTPException(404, "File not found")
    return FileResponse(path)


# ---------------------------------------------------------------------------
# Image upload / metadata
# ---------------------------------------------------------------------------

@router.post("/api/image/upload")
async def upload_image(file: UploadFile = File(...), image_path: str = Form("")):
    raw = await file.read()
    image = Image.open(io.BytesIO(raw)).copy()
    _state["current_image"] = image
    _state["current_image_path"] = image_path
    b64 = image_to_b64(image)
    meta = read_a1111_metadata(image) or read_comfyui_metadata(image)
    saved_json = None
    if image_path:
        try:
            json_path = Path(image_path).with_suffix(".json")
            if json_path.is_file():
                with open(json_path, "r", encoding="utf-8") as f:
                    saved_json = json.load(f)
        except Exception:
            saved_json = None
    if meta is None:
        return {
            "image": b64,
            "status": "画像を読み込みました。メタデータが見つかりません。",
            "meta": None,
            "saved_json": saved_json,
        }
    source = "A1111" if image.info.get("parameters") else "ComfyUI"
    return {
        "image": b64,
        "status": f"メタデータを読み込みました。({source})",
        "meta": {
            "positive": meta.get("positive", ""),
            "negative": meta.get("negative", ""),
            "steps": meta.get("steps"),
            "cfg_scale": meta.get("cfg_scale"),
            "sampler": meta.get("sampler"),
            "width": meta.get("width"),
            "height": meta.get("height"),
            "seed": meta.get("seed"),
        },
        "saved_json": saved_json,
    }


@router.post("/api/image/clear")
def clear_image():
    _state["current_image"] = None
    _state["current_image_stem"] = ""
    _state["current_image_path"] = ""
    return {"ok": True}


@router.post("/api/video/image/upload")
async def upload_video_image(file: UploadFile = File(...), image_path: str = Form("")):
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).copy()
    except Exception as exc:
        raise HTTPException(400, f"画像を読み込めませんでした: {exc}") from exc
    _state["video_input_image"] = image
    _state["video_input_image_path"] = image_path
    meta = read_a1111_metadata(image) or read_comfyui_metadata(image)
    saved_json = None
    if image_path:
        try:
            json_path = Path(image_path).with_suffix(".json")
            if json_path.is_file():
                saved_json = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            saved_json = None
    return {
        "ok": True,
        "image": image_to_b64(image),
        "positive": (meta or {}).get("positive", ""),
        "saved_json": saved_json,
        "status": (
            "基画像とメタデータのプロンプトを読み込みました。"
            if meta
            else "基画像を読み込みました。プロンプトのメタデータはありません。"
        ),
    }


@router.post("/api/video/image/from-current")
def copy_current_image_to_video():
    image = _state.get("current_image")
    if image is None:
        return {"ok": False, "message": "画像生成に転送できる画像がありません。"}
    video_image = image.copy()
    _state["video_input_image"] = video_image
    _state["video_input_image_path"] = _state.get("current_image_path", "")
    return {
        "ok": True,
        "image": image_to_b64(video_image),
        "status": "画像生成からイメージとプロンプトを取得しました。",
    }


@router.post("/api/json/upload")
async def upload_json(file: UploadFile = File(...)):
    raw = await file.read()
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"ok": False, "message": "JSON を読み取れませんでした"}

    image_path = (
        (data.get("image_path") or "").strip()
        or str((data.get("metadata") or {}).get("path", "")).strip()
    )
    if not image_path:
        return {"ok": False, "message": "JSON に画像パスがありません"}

    try:
        image = Image.open(image_path).copy()
    except Exception as e:
        return {"ok": False, "message": f"画像を開けませんでした: {e}"}

    _state["current_image"] = image
    _state["current_image_path"] = image_path
    b64 = image_to_b64(image)
    meta = read_a1111_metadata(image) or read_comfyui_metadata(image)

    return {
        "ok": True,
        "image": b64,
        "image_path": image_path,
        "status": "JSON を読み込みました。",
        "meta": {
            "positive": (meta or {}).get("positive", ""),
            "negative": (meta or {}).get("negative", ""),
            "steps": (meta or {}).get("steps"),
            "cfg_scale": (meta or {}).get("cfg_scale"),
            "sampler": (meta or {}).get("sampler"),
            "width": (meta or {}).get("width"),
            "height": (meta or {}).get("height"),
            "seed": (meta or {}).get("seed"),
        } if meta else None,
        "saved_json": data,
    }


@router.post("/api/seed_from_image")
def seed_from_image():
    image = _state.get("current_image")
    if image is None:
        return {"ok": False, "message": "現在の画像がありません"}
    meta = read_a1111_metadata(image) or read_comfyui_metadata(image)
    if meta is None or "seed" not in meta:
        return {"ok": False, "message": "メタデータに Seed がありません"}
    seed = int(meta["seed"])
    return {"ok": True, "seed": seed, "message": f"Seed を反映しました: {seed}"}


@router.post("/api/seed_from_video")
def seed_from_video():
    video_path = _state.get("current_video_path", "")
    if not video_path:
        return {"ok": False, "message": "現在の動画がありません"}
    stem = os.path.splitext(os.path.basename(video_path))[0]
    parts = stem.split("-", 1)
    if len(parts) == 2 and parts[1].lstrip("-").isdigit():
        seed = int(parts[1])
        return {"ok": True, "seed": seed, "message": f"Seed を反映しました: {seed}"}
    return {"ok": False, "message": "ファイル名から Seed を読み取れませんでした"}


# ---------------------------------------------------------------------------
# Image generation
# ---------------------------------------------------------------------------

@router.post("/api/generate_image/stream")
async def generate_image_stream(request: Request):
    body = await request.json()
    positive = body.get("positive", "")
    negative = body.get("negative", "")
    steps = int(body.get("steps", 28))
    cfg = float(body.get("cfg", 7.0))
    sampler = body.get("sampler", "Euler a")
    width = int(body.get("width", 512))
    height = int(body.get("height", 768))
    seed = int(body.get("seed", -1))
    backend = body.get("backend", "WebUI Forge")
    comfyui_workflow = body.get("comfyui_workflow", "")
    comfyui_width = int(body.get("comfyui_width", 1024))
    comfyui_height = int(body.get("comfyui_height", 1024))
    comfyui_seed = int(body.get("comfyui_seed", -1))
    save_dir = (body.get("image_save_path", "") or "").strip() or "./outputs/images"

    _state["positive_prompt"] = positive
    _state["negative_prompt"] = negative

    async def event_gen():
        seed_i = seed
        cseed_i = comfyui_seed
        yield sse_event({"type": "status", "content": "生成中..."})
        try:
            start = time.time()
            if backend == "ComfyUI":
                if comfy_process.is_enabled():
                    yield sse_event({"type": "status", "content": "ComfyUI の起動を確認中..."})
                    await run_in_thread(comfy_process.wait_until_ready)
                wf_path = comfyui_client.IMAGE_WORKFLOW_PRESETS.get(comfyui_workflow, comfyui_workflow)
                image = await run_in_thread(
                    comfyui_client.generate_image,
                    workflow_path=wf_path,
                    positive=positive,
                    negative=negative,
                    seed=cseed_i,
                    width=comfyui_width,
                    height=comfyui_height,
                )
            else:
                if sd_process.is_enabled():
                    yield sse_event({"type": "status", "content": "Forge の起動を確認中..."})
                    await run_in_thread(sd_process.wait_until_ready)
                image = await run_in_thread(
                    a1111_client.generate_image,
                    positive=positive,
                    negative=negative,
                    steps=steps,
                    cfg=cfg,
                    sampler=sampler,
                    width=width,
                    height=height,
                    seed=seed_i,
                )
            elapsed = time.time() - start

            if not isinstance(image, Image.Image):
                yield sse_event({"type": "error", "content": "画像の取得に失敗しました"})
            else:
                _state["current_image"] = image
                _state["current_image_stem"] = (
                    comfyui_client.get_last_output_filename()
                    if backend == "ComfyUI"
                    else time.strftime("forge_%Y%m%d_%H%M%S")
                )
                saved_path = ""
                save_status = ""
                try:
                    os.makedirs(save_dir, exist_ok=True)
                    meta = read_a1111_metadata(image) or read_comfyui_metadata(image) or {}
                    sv = int(meta.get("seed", cseed_i if backend == "ComfyUI" else seed_i) or 0)
                    fname = f"{get_next_seq(save_dir, ('.png',)):05d}-{sv}.png"
                    sp = os.path.abspath(os.path.join(save_dir, fname))
                    pnginfo = build_pnginfo(image)
                    image.save(sp, pnginfo=pnginfo) if pnginfo else image.save(sp)
                    saved_path = sp
                    _state["current_image_path"] = sp
                except Exception as se:
                    save_status = f" / 保存失敗: {se}"
                yield sse_event({
                    "type": "image",
                    "image": image_to_b64(image),
                    "saved_path": saved_path,
                    "status": f"画像を生成しました。（{elapsed:.1f}秒）{save_status}",
                })
        except Exception as e:
            yield sse_event({"type": "error", "content": f"画像生成エラー: {e}"})

        yield sse_event({"type": "done"})

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@router.post("/api/interrupt_image")
def interrupt_image():
    comfyui_client.interrupt()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Video generation
# ---------------------------------------------------------------------------

@router.post("/api/stop_video")
def stop_video():
    next_video_gen_id()
    comfyui_client.interrupt()
    return {"ok": True, "message": "動画生成をキャンセルしました"}


@router.post("/api/generate_video/stream")
async def generate_video_stream(request: Request):
    my_id = next_video_gen_id()

    body = await request.json()
    video_prompt_text = body.get("video_prompt", "")
    workflow_name = body.get("workflow", "")
    seed = int(body.get("seed", -1))
    width = int(body.get("width", 848)) if body.get("width") else None
    height = int(body.get("height", 480)) if body.get("height") else None
    frames = int(body.get("frames", 81)) if body.get("frames") else None
    save_dir = (body.get("video_save_path", "") or "").strip() or "./outputs/videos"
    unload_llm = bool(body.get("unload_llm_before_video", False))

    video_input_image = _state.get("video_input_image")
    if video_input_image is None:
        async def no_img():
            yield sse_event({"type": "error", "content": "基にするイメージがありません。動画ページに画像をセットしてください。"})
        return StreamingResponse(no_img(), media_type="text/event-stream")

    if unload_llm:
        await run_in_thread(llm_client.unload_model)

    result_box: list = []
    error_box: list = []

    def _run():
        if my_id != current_video_gen_id():
            return
        try:
            if comfy_process.is_enabled():
                comfy_process.wait_until_ready()
            wf_path = comfyui_client.VIDEO_WORKFLOW_PRESETS.get(workflow_name, workflow_name)
            result_box.append(comfyui_client.generate_image(
                workflow_path=wf_path,
                positive=video_prompt_text,
                negative="",
                seed=seed,
                width=width,
                height=height,
                frames=frames,
                input_image=video_input_image,
            ))
        except Exception as e:
            error_box.append(e)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    start = time.time()

    async def event_gen():
        while t.is_alive():
            if my_id != current_video_gen_id():
                return
            yield sse_event({
                "type": "status",
                "content": f"動画生成中... {time.time() - start:.0f}秒",
            })
            await asyncio.sleep(1)

        if my_id != current_video_gen_id():
            return

        elapsed = time.time() - start
        if error_box:
            yield sse_event({"type": "error", "content": f"動画生成エラー: {error_box[0]}"})
        elif result_box:
            result = result_box[0]
            if isinstance(result, str):
                saved_path = ""
                save_status = ""
                try:
                    os.makedirs(save_dir, exist_ok=True)
                    ext = os.path.splitext(result)[1].lower() or ".mp4"
                    if ext not in {".mp4", ".webm", ".avi", ".mov"}:
                        ext = ".mp4"
                    used_seed = comfyui_client.get_last_actual_seed()
                    fname = (
                        f"{get_next_seq(save_dir, ('.mp4', '.webm', '.avi', '.mov')):05d}"
                        f"-{int(used_seed)}{ext}"
                    )
                    sp = os.path.abspath(os.path.join(save_dir, fname))
                    shutil.copy2(result, sp)
                    saved_path = sp
                    _state["current_video_path"] = sp
                except Exception as se:
                    save_status = f" / 保存失敗: {se}"
                token = str(uuid.uuid4())
                if saved_path:
                    # 保存済みファイルを配信し、一時ファイルは削除して溜めない
                    _temp_files[token] = saved_path
                    try:
                        os.remove(result)
                    except OSError:
                        pass
                else:
                    _temp_files[token] = result
                yield sse_event({
                    "type": "video",
                    "url": f"/api/file/{token}",
                    "saved_path": saved_path,
                    "status": f"動画生成完了（{elapsed:.0f}秒）{save_status}",
                })
            else:
                yield sse_event({"type": "error", "content": "動画ではなく画像として出力されました"})
        else:
            yield sse_event({"type": "error", "content": "結果が取得できませんでした"})

    return StreamingResponse(event_gen(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Save JSON sidecar
# ---------------------------------------------------------------------------

@router.post("/api/save_json")
async def save_json_endpoint(request: Request):
    body = await request.json()
    video_prompt = body.get("video_prompt", "")
    additional_instruction = body.get("additional_instruction", "")
    comfyui_workflow = body.get("comfyui_workflow", "")
    video_workflow = body.get("video_workflow", "")

    image_path = _state.get("video_input_image_path", "")
    if not image_path:
        return {"ok": False, "message": "動画ページに保存元の画像が読み込まれていません"}

    image = _state.get("video_input_image")
    meta_raw = {}
    if image:
        meta_raw = read_a1111_metadata(image) or read_comfyui_metadata(image) or {}

    p = Path(image_path)
    size_list = list(image.size) if image else []
    _exclude = {"positive", "negative", "width", "height"}
    settings = {k: v for k, v in meta_raw.items() if k not in _exclude}

    data = {
        "image_filename": p.name,
        "image_path": str(p),
        "metadata": {
            "path": str(p),
            "filename": p.name,
            "size": size_list,
            "prompt": meta_raw.get("positive", ""),
            "negative_prompt": meta_raw.get("negative", ""),
            "settings": settings,
        },
        "prompt": video_prompt,
        "additional_instruction": additional_instruction,
        "comfyui_workflow": comfyui_workflow,
        "video_workflow": video_workflow,
    }

    json_path = p.parent / (p.stem + ".json")
    try:
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return {"ok": True, "message": f"保存しました: {json_path}"}
    except Exception as e:
        return {"ok": False, "message": f"保存エラー: {e}"}
