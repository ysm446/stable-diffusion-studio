"""
server.py
Electron アプリ向け FastAPI バックエンドサーバー
"""

import argparse

import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import a1111_client
import comfy_process
import comfyui_client
import sd_process
import settings_manager
from helpers import BASE_DIR, FRONTEND_DIR
from routes.admin import router as admin_router
from routes.chat import router as chat_router
from routes.generation import router as generation_router
from routes.library import router as library_router

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = FastAPI()

# フロントエンドは同一オリジンから配信されるため、自オリジンのみ許可する。
# ワイルドカードにするとブラウザ上の任意のページから API を叩けてしまう。
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


app.include_router(library_router)
app.include_router(generation_router)
app.include_router(chat_router)
app.include_router(admin_router)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    settings = settings_manager.load()
    comfyui_client.reload_workflows()
    sd_process.configure(settings)
    if sd_process.is_enabled():
        a1111_client.set_preferred_forge_url(sd_process.get_url())
        sd_process.start_background()
    comfy_process.configure(settings)
    if comfy_process.is_enabled():
        comfyui_client.COMFYUI_URL = comfy_process.get_url()
        comfy_process.start_background()
    else:
        comfyui_client.COMFYUI_URL = settings.get("comfyui_url", "http://127.0.0.1:8188")

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
