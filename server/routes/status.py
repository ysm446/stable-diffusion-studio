"""バックエンドサービスの起動状態を返す API。

Forge / ComfyUI / LLM / Embedding の各 llama-server・生成サーバーに軽量な
HTTP プローブを投げて、起動しているかどうかだけを返す。管理対象プロセスの
起動・停止はしない（状態表示のみ）。
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import requests
from fastapi import APIRouter

from server.generation import comfy_process, sd_process

router = APIRouter(prefix="/api/status")

_TIMEOUT = 0.6


def _probe(url: str, ok_codes=(200,)) -> bool:
    try:
        return requests.get(url, timeout=_TIMEOUT).status_code in ok_codes
    except requests.RequestException:
        return False


def _probe_any(urls: list[str], ok_codes=(200,)) -> tuple[bool, str]:
    for url in urls:
        if _probe(url, ok_codes):
            return True, url
    return False, urls[0] if urls else ""


def _forge_status() -> dict[str, Any]:
    urls = []
    try:
        urls.append(sd_process.get_url())  # 管理対象 (既定 7861)
    except Exception:
        pass
    urls.append("http://127.0.0.1:7860")  # 外部起動でよく使うポート
    ready, url = _probe_any(list(dict.fromkeys(urls)))
    return {"key": "forge", "label": "Forge", "ready": ready, "url": url}


def _comfy_status() -> dict[str, Any]:
    try:
        base = comfy_process.get_url()
    except Exception:
        base = "http://127.0.0.1:8188"
    ready = _probe(f"{base}/system_stats")
    return {"key": "comfyui", "label": "ComfyUI", "ready": ready, "url": base}


def _llm_status() -> dict[str, Any]:
    port = os.getenv("LLAMA_SERVER_PORT", "8090")
    base = f"http://127.0.0.1:{port}"
    ready = _probe(f"{base}/health")
    return {"key": "llm", "label": "LLM", "ready": ready, "url": base}


def _embedding_status() -> dict[str, Any]:
    port = os.getenv("EMBEDDING_SERVER_PORT", "8091")
    base = f"http://127.0.0.1:{port}"
    ready = _probe(f"{base}/health")
    return {"key": "embedding", "label": "Embedding", "ready": ready, "url": base}


@router.get("")
def get_status() -> dict[str, Any]:
    checks = [_forge_status, _comfy_status, _llm_status, _embedding_status]
    with ThreadPoolExecutor(max_workers=len(checks)) as pool:
        services = list(pool.map(lambda fn: fn(), checks))
    return {"services": services}
