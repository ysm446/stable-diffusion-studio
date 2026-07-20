"""FastAPI バックエンドサーバー（ライブラリ中心構成）。

起動: python -m server.main --port 8785
（旧 Image Assistant が 8765 を使うため、競合しないよう別ポートにしている）
"""

from __future__ import annotations

import argparse
import os
import threading
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from server import settings
from server.generation import comfy_client, comfy_process, forge_client, sd_process
from server.routes.generation import router as generation_router
from server.routes.library import router as library_router
from server.routes.llm import router as llm_router
from server.routes.sequences import router as sequences_router
from server.routes.status import router as status_router

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI()

# フロントエンドは同一オリジンから配信されるため、自オリジンのみ許可する。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8785",
        "http://localhost:8785",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/frontend", StaticFiles(directory=str(FRONTEND_DIR)), name="frontend")
app.mount("/assets", StaticFiles(directory=str(BASE_DIR / "assets")), name="assets")


@app.middleware("http")
async def no_cache_middleware(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/frontend/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/")
def index():
    return FileResponse(str(FRONTEND_DIR / "index.html"))


@app.get("/api/settings")
def get_settings():
    return settings.load()


@app.put("/api/settings")
def put_settings(body: dict):
    return settings.update(body)


app.include_router(library_router)
app.include_router(generation_router)
app.include_router(sequences_router)
app.include_router(status_router)
app.include_router(llm_router)


@app.on_event("startup")
def configure_backends() -> None:
    current = settings.load()
    comfy_client.reload_workflows()
    sd_process.configure(current)
    comfy_process.configure(current)
    if sd_process.is_enabled():
        forge_client.set_preferred_forge_url(sd_process.get_url())


def free_all_vram() -> list[str]:
    """全バックエンドの VRAM を解放する。

    管理対象プロセス（Forge / ComfyUI）は停止、外部プロセスはモデルのみ
    アンロード。LLM・embedding の llama-server も停止する。個別に失敗しても続行。
    """
    results: list[str] = []

    def _try(label, fn):
        try:
            results.append(f"{label}: {fn()}")
        except Exception as e:
            results.append(f"{label}: skipped ({e})")

    # LLM / embedding は常にプロセス停止
    from server.generation import embedding_client, llm_client

    _try("LLM", llm_client.unload_model)
    _try("Embedding", embedding_client.stop)

    # ComfyUI: 管理対象なら停止、外部ならモデル解放
    if comfy_process.is_enabled():
        _try("ComfyUI", comfy_process.stop)
    else:
        _try("ComfyUI", comfy_client.free_vram)

    # Forge: 管理対象なら停止、外部ならチェックポイント解放
    if sd_process.is_enabled():
        _try("Forge", sd_process.stop)
        forge_client.reset_connection()
    else:
        _try("Forge", forge_client.free_vram)

    return results


@app.on_event("shutdown")
def _on_shutdown() -> None:
    free_all_vram()


@app.post("/api/shutdown")
def shutdown():
    """アプリ終了時に呼ばれる。VRAM を解放してからサーバープロセスを終了する。"""
    results = free_all_vram()
    # レスポンスを返してからプロセスを終了する
    threading.Timer(0.4, lambda: os._exit(0)).start()
    return {"ok": True, "freed": results}


@app.post("/api/free_vram")
def free_vram_endpoint():
    """サーバーは終了せず VRAM だけ解放する（手動解放用）。"""
    return {"ok": True, "freed": free_all_vram()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8785)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
