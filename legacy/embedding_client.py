from __future__ import annotations

import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import requests

ROOT_DIR = Path(__file__).resolve().parent
MODELS_DIR = ROOT_DIR / "models"
SERVER_LOG = ROOT_DIR / "embedding_server.log"

HOST = "127.0.0.1"
PORT = int(os.getenv("EMBEDDING_SERVER_PORT", "8091"))
BASE_URL = f"http://{HOST}:{PORT}"
MODEL_HINT = os.getenv("EMBEDDING_MODEL", "Qwen3-Embedding-4B")

_proc: subprocess.Popen | None = None
_log_fh: Any = None
_loaded_model_path: Path | None = None
_ready = False
_last_error = ""
_lock = threading.RLock()


def _find_llama_server_exe() -> Path:
    env_path = os.getenv("EMBEDDING_SERVER_EXE") or os.getenv("LLAMA_SERVER_EXE")
    if env_path:
        return Path(env_path)
    search_dir = ROOT_DIR / "runtime" / "llama-server"
    if search_dir.is_dir():
        candidates = sorted(
            (d / "llama-server.exe" for d in search_dir.iterdir() if d.is_dir()),
            key=lambda p: p.parent.name,
            reverse=True,
        )
        for candidate in candidates:
            if candidate.exists():
                return candidate
    return search_dir / "llama-server.exe"


def _find_embedding_model() -> Path:
    env_path = os.getenv("EMBEDDING_MODEL_PATH")
    if env_path:
        return Path(env_path)
    preferred_dir = MODELS_DIR / "Qwen3-Embedding-4B-GGUF"
    candidates = []
    if preferred_dir.is_dir():
        candidates.extend(sorted(preferred_dir.glob("*Q4_K_M*.gguf")))
        candidates.extend(sorted(preferred_dir.glob("*.gguf")))
    candidates.extend(sorted(MODELS_DIR.rglob("*Embedding*Q4_K_M*.gguf")))
    candidates.extend(sorted(MODELS_DIR.rglob("*Embedding*.gguf")))
    if candidates:
        return candidates[0]
    raise RuntimeError("Embedding GGUF モデルが見つかりません。models/Qwen3-Embedding-4B-GGUF を確認してください。")


def _creationflags() -> int:
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags |= subprocess.CREATE_NO_WINDOW
    return flags


def _wait_until_ready(timeout: int = 120) -> None:
    global _ready, _last_error
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _proc is not None and _proc.poll() is not None:
            tail = ""
            try:
                tail = SERVER_LOG.read_text(encoding="utf-8", errors="replace")[-2000:]
            except Exception:
                pass
            raise RuntimeError(f"embedding llama-server が終了しました。\n{tail}")
        try:
            resp = requests.get(f"{BASE_URL}/health", timeout=3)
            if resp.status_code == 200:
                _ready = True
                _last_error = ""
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f"embedding llama-server の起動がタイムアウトしました。ログ: {SERVER_LOG}")


def is_loaded() -> bool:
    return _proc is not None and _proc.poll() is None


def is_ready() -> bool:
    if not is_loaded():
        return False
    try:
        return requests.get(f"{BASE_URL}/health", timeout=1).status_code == 200
    except Exception:
        return False


def stop() -> str:
    global _proc, _log_fh, _loaded_model_path, _ready, _last_error
    with _lock:
        if _proc is not None and _proc.poll() is None:
            _proc.terminate()
            try:
                _proc.wait(timeout=15)
            except subprocess.TimeoutExpired:
                _proc.kill()
        _proc = None
        _loaded_model_path = None
        if _log_fh is not None:
            try:
                _log_fh.close()
            except Exception:
                pass
            _log_fh = None
        _ready = False
        _last_error = ""
        return "Embedding server stopped"


def ensure_loaded() -> str:
    global _proc, _log_fh, _loaded_model_path, _ready, _last_error
    with _lock:
        if is_ready():
            _ready = True
            return f"Embedding server is running ({BASE_URL})"
        if is_loaded():
            stop()

        exe = _find_llama_server_exe()
        model_path = _find_embedding_model()
        if not exe.exists():
            raise RuntimeError(f"llama-server.exe が見つかりません: {exe}")
        if not model_path.exists():
            raise RuntimeError(f"Embedding モデルが見つかりません: {model_path}")

        if _log_fh is not None:
            try:
                _log_fh.close()
            except Exception:
                pass
        _log_fh = open(SERVER_LOG, "w", encoding="utf-8", errors="replace")
        cmd = [
            str(exe),
            "-m",
            str(model_path),
            "--host",
            HOST,
            "--port",
            str(PORT),
            "--embedding",
            "--pooling",
            "last",
            "-ub",
            os.getenv("EMBEDDING_UBATCH", "8192"),
        ]
        _proc = subprocess.Popen(
            cmd,
            cwd=str(ROOT_DIR),
            stdout=_log_fh,
            stderr=_log_fh,
            creationflags=_creationflags(),
        )
        _loaded_model_path = model_path
        _ready = False
        _last_error = ""
        try:
            _wait_until_ready()
        except Exception as e:
            _last_error = str(e)
            if _proc is not None and _proc.poll() is None:
                _proc.terminate()
            raise
        return f"Embedding server started ({model_path.name}, {BASE_URL})"


def embed_text(text: str) -> tuple[list[float], str]:
    ensure_loaded()
    resp = requests.post(
        f"{BASE_URL}/v1/embeddings",
        json={"model": MODEL_HINT, "input": text},
        timeout=120,
    )
    resp.raise_for_status()
    data = resp.json()
    vector = data["data"][0]["embedding"]
    model_name = str(_loaded_model_path.name if _loaded_model_path else MODEL_HINT)
    return [float(v) for v in vector], model_name


def status() -> dict[str, Any]:
    process_running = is_loaded()
    ready = is_ready()
    model = str(_loaded_model_path) if _loaded_model_path else MODEL_HINT
    error = _last_error
    return {
        "enabled": True,
        "ready": ready,
        "process_running": process_running,
        "returncode": None if process_running else (_proc.returncode if _proc is not None else None),
        "url": BASE_URL,
        "model": model,
        "log": str(SERVER_LOG),
        "error": error,
    }
