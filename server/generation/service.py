"""生成結果をライブラリに保存するサービス層。

ルート（SSE）から呼ばれる同期処理。バックエンド呼び出し → PNG メタデータ付きで
シリアライズ → ライブラリアイテムとして保存、までを担当する。
"""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
from typing import Any, Callable

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from server.generation import comfy_client, comfy_process, forge_client, sd_process
from server.library import items, png_meta

StatusFn = Callable[[str], None]


def build_pnginfo(image: Image.Image) -> PngInfo | None:
    """PIL Image が持つメタデータ（A1111 parameters / ComfyUI prompt 等）を PngInfo にする。"""
    info = getattr(image, "info", {}) or {}
    pnginfo = PngInfo()
    added = False
    for k, v in info.items():
        if v is None:
            continue
        if isinstance(v, str):
            pnginfo.add_text(str(k), v)
            added = True
        elif isinstance(v, (dict, list)):
            try:
                pnginfo.add_text(str(k), json.dumps(v, ensure_ascii=False))
                added = True
            except Exception:
                pass
    return pnginfo if added else None


def image_to_png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    pnginfo = build_pnginfo(image)
    if pnginfo:
        image.save(buf, "PNG", pnginfo=pnginfo)
    else:
        image.save(buf, "PNG")
    return buf.getvalue()


def generate_image_to_item(params: dict[str, Any], status: StatusFn) -> dict[str, Any]:
    """画像を生成し、指定フォルダのライブラリアイテムとして保存する。"""
    folder = params.get("folder", "")
    positive = params.get("positive", "")
    negative = params.get("negative", "")
    backend = params.get("backend", "WebUI Forge")
    seed = int(params.get("seed", -1))

    status("生成中...")
    if backend == "ComfyUI":
        if comfy_process.is_enabled():
            status("ComfyUI の起動を確認中...")
            comfy_process.wait_until_ready()
        workflow = params.get("workflow", "")
        wf_path = comfy_client.IMAGE_WORKFLOW_PRESETS.get(workflow, workflow)
        status("ComfyUI で生成中...")
        image = comfy_client.generate_image(
            workflow_path=wf_path,
            positive=positive,
            negative=negative,
            seed=seed,
            width=int(params["width"]) if params.get("width") else None,
            height=int(params["height"]) if params.get("height") else None,
        )
        if not isinstance(image, Image.Image):
            raise RuntimeError("画像ワークフローから動画が出力されました。ワークフロー選択を確認してください。")
        used_seed = comfy_client.get_last_actual_seed()
        gen_params: dict[str, Any] = {
            "backend": backend,
            "workflow": workflow,
        }
    else:
        if sd_process.is_enabled():
            status("Forge の起動を確認中...")
            sd_process.wait_until_ready()
        status("Forge で生成中...")
        image = forge_client.generate_image(
            positive=positive,
            negative=negative,
            steps=int(params.get("steps", 28)),
            cfg=float(params.get("cfg", 7.0)),
            sampler=params.get("sampler", "Euler a"),
            width=int(params.get("width", 1024)),
            height=int(params.get("height", 1024)),
            seed=seed,
        )
        used_seed = seed
        gen_params = {
            "backend": backend,
            "steps": int(params.get("steps", 28)),
            "cfg": float(params.get("cfg", 7.0)),
            "sampler": params.get("sampler", "Euler a"),
        }

    # 生成画像のメタデータから実際の seed 等を反映
    meta_raw = (
        png_meta.read_a1111_metadata(image) or png_meta.read_comfyui_metadata(image) or {}
    )
    if meta_raw.get("seed") is not None:
        try:
            used_seed = int(meta_raw["seed"])
        except (TypeError, ValueError):
            pass
    gen_params["width"], gen_params["height"] = image.size
    for key in ("steps", "cfg_scale", "sampler"):
        if meta_raw.get(key) is not None:
            gen_params.setdefault(key.replace("cfg_scale", "cfg"), meta_raw[key])

    status("ライブラリに保存中...")
    return items.create_item(
        folder,
        image_to_png_bytes(image),
        prompt=positive or meta_raw.get("positive", ""),
        negative_prompt=negative or meta_raw.get("negative", ""),
        seed=used_seed if used_seed >= 0 else None,
        params=gen_params,
    )


def generate_video_for_item(params: dict[str, Any], status: StatusFn) -> dict[str, Any]:
    """アイテムの画像を基に動画を生成し、そのアイテムに紐づけて保存する。"""
    item_id = params["item_id"]
    prompt = params.get("prompt", "")
    workflow = params.get("workflow", "")
    seed = int(params.get("seed", -1))

    d = items.item_dir(item_id)
    meta = items.get_item(item_id)
    image = Image.open(d / meta["image"]).copy()

    if comfy_process.is_enabled():
        status("ComfyUI の起動を確認中...")
        comfy_process.wait_until_ready()

    wf_path = comfy_client.VIDEO_WORKFLOW_PRESETS.get(workflow, workflow)
    status("動画を生成中...")
    result = comfy_client.generate_image(
        workflow_path=wf_path,
        positive=prompt,
        negative="",
        seed=seed,
        width=int(params["width"]) if params.get("width") else None,
        height=int(params["height"]) if params.get("height") else None,
        frames=int(params["frames"]) if params.get("frames") else None,
        input_image=image,
    )
    if not isinstance(result, str):
        raise RuntimeError("動画ではなく画像として出力されました。ワークフロー選択を確認してください。")

    status("ライブラリに保存中...")
    ext = os.path.splitext(result)[1].lower()
    if ext not in (".mp4", ".webm", ".avi", ".mov"):
        ext = ".mp4"
    try:
        video_bytes = Path(result).read_bytes()
    finally:
        try:
            os.remove(result)
        except OSError:
            pass
    return items.add_video(
        item_id,
        video_bytes,
        ext=ext,
        prompt=prompt,
        workflow=workflow,
    )
