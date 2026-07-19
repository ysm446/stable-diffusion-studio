"""FastAPI バックエンドサーバー（ライブラリ中心構成）。

起動: python -m server.main --port 8765
"""

from __future__ import annotations

import argparse
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
from server.routes.sequences import router as sequences_router

BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

app = FastAPI()

# フロントエンドは同一オリジンから配信されるため、自オリジンのみ許可する。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:8765",
        "http://localhost:8765",
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


@app.on_event("startup")
def configure_backends() -> None:
    current = settings.load()
    comfy_client.reload_workflows()
    sd_process.configure(current)
    comfy_process.configure(current)
    if sd_process.is_enabled():
        forge_client.set_preferred_forge_url(sd_process.get_url())


@app.on_event("shutdown")
def stop_managed_backends() -> None:
    sd_process.stop()
    comfy_process.stop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
