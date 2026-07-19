from __future__ import annotations

import asyncio
import base64
import functools
import io
import json
import os
import re
from pathlib import Path
from typing import Any

from PIL import Image
from PIL.PngImagePlugin import PngInfo

import embedding_client
import image_library
import llm_client
import settings_manager

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = BASE_DIR / "frontend"
DEFAULT_SNIPPETS_DIR = BASE_DIR / "snippets"


def get_snippets_dir() -> Path:
    """現在のスニペットのルートフォルダを返す。

    設定 ``snippets_root`` が指定されていればそれを使い、なければ既定の
    ``snippets`` を返す。相対パスは BASE_DIR 基準で解決する。
    """
    raw = ""
    try:
        raw = (settings_manager.load().get("snippets_root") or "").strip()
    except Exception:
        raw = ""
    if raw:
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = (BASE_DIR / p).resolve()
        return p
    return DEFAULT_SNIPPETS_DIR


def image_to_b64(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def get_next_seq(save_dir: str, exts: tuple) -> int:
    pattern = re.compile(r"^(\d{5})-")
    max_seq = 0
    try:
        for name in os.listdir(save_dir):
            if not any(name.lower().endswith(e) for e in exts):
                continue
            m = pattern.match(name)
            if m:
                max_seq = max(max_seq, int(m.group(1)))
    except Exception:
        return 1
    return max_seq + 1


def build_pnginfo(image: Image.Image) -> PngInfo | None:
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


async def run_in_thread(func, *args, **kwargs):
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))


def resolve_default_model_label(requested: str = "") -> str:
    if requested:
        return requested
    presets = llm_client.refresh_model_presets()
    saved = settings_manager.load().get("model", "")
    if saved and saved in presets:
        return saved
    return next(iter(presets.keys()), "")


def build_library_context(user_input: str, limit: int = 5, search_mode: str = "vector") -> str:
    items: list = []
    try:
        vector, _ = embedding_client.embed_text(user_input)
        if search_mode == "hybrid":
            items = image_library.search_hybrid(vector, user_input, limit=limit)
        else:
            items = image_library.search_by_embedding(vector, limit=limit)
    except Exception:
        pass

    if not items:
        all_items = image_library.list_images(query=user_input)
        items = [i for i in all_items if i.get("positive_prompt", "").strip()][:limit]

    if not items:
        return "（ライブラリにプロンプトが見つかりませんでした）"

    lines = []
    for idx, item in enumerate(items, 1):
        pos = (item.get("positive_prompt") or "").strip()
        cap = (item.get("caption") or "").strip()
        if pos:
            line = f"例{idx}:\n  プロンプト: {pos}"
            if cap:
                line += f"\n  説明: {cap}"
            lines.append(line)
    return "\n".join(lines) if lines else "（該当するプロンプトが見つかりませんでした）"


def strip_jsonc_comments(text: str) -> str:
    lines = []
    for line in text.splitlines():
        in_string = False
        escaped = False
        comment_at = None
        for i, ch in enumerate(line):
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if not in_string and ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
                comment_at = i
                break
        lines.append(line[:comment_at] if comment_at is not None else line)
    return "\n".join(lines)
