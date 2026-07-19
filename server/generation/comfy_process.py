"""
comfy_process.py
Project-local ComfyUI process management.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import requests

from server.generation.managed_process import (
    close_quietly,
    env_enabled,
    pid_exists,
    process_creationflags,
    read_tail,
    resolve_dir,
    terminate_process_tree,
)

_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
_DEFAULT_COMFY_DIR = _ROOT_DIR / "runtime" / "ComfyUI"
_COMFY_LOG = _ROOT_DIR / "comfyui_server.log"
_PID_FILE = _ROOT_DIR / "comfyui_server.pid"
_SETUP_MARKER = ".prompt_assistant_setup"

_lock = threading.RLock()
_comfy_proc: subprocess.Popen | None = None
_comfy_log_fh: Any = None
_comfy_dir: Path = Path(os.getenv("COMFYUI_DIR", str(_DEFAULT_COMFY_DIR)))
_host = os.getenv("COMFYUI_HOST", "127.0.0.1")
_port = int(os.getenv("COMFYUI_PORT", "8188"))
_enabled = env_enabled("MANAGED_COMFYUI")
_installing = False


def configure(settings: dict[str, Any]) -> None:
    """Apply settings/env overrides before starting ComfyUI."""
    global _comfy_dir, _host, _port, _enabled
    with _lock:
        if os.getenv("MANAGED_COMFYUI") is not None:
            _enabled = env_enabled("MANAGED_COMFYUI")
        else:
            _enabled = bool(settings.get("managed_comfyui_enabled", _enabled))
        _comfy_dir = resolve_dir(
            _ROOT_DIR,
            os.getenv("COMFYUI_DIR")
            or settings.get("managed_comfyui_dir")
            or str(_DEFAULT_COMFY_DIR),
        )
        _host = str(os.getenv("COMFYUI_HOST") or settings.get("managed_comfyui_host") or "127.0.0.1")
        _port = int(os.getenv("COMFYUI_PORT") or settings.get("managed_comfyui_port") or 8188)


def get_url() -> str:
    return f"http://{_host}:{_port}"


def is_enabled() -> bool:
    return _enabled


def is_process_running() -> bool:
    if _comfy_proc is not None and _comfy_proc.poll() is None:
        return True
    pid = _read_pid()
    return pid_exists(pid)


def _read_pid() -> int | None:
    try:
        return int(_PID_FILE.read_text(encoding="utf-8").strip())
    except Exception:
        return None


def _is_http_ready() -> bool:
    try:
        resp = requests.get(f"{get_url()}/system_stats", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def is_ready() -> bool:
    return _is_http_ready()


def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "url": get_url(),
        "dir": str(_comfy_dir),
        "process_running": is_process_running(),
        "installing": _installing,
        "ready": is_ready(),
        "log": str(_COMFY_LOG),
        "returncode": None if _comfy_proc is None else _comfy_proc.poll(),
    }


def _venv_python() -> Path:
    if os.name == "nt":
        return _comfy_dir / "venv" / "Scripts" / "python.exe"
    return _comfy_dir / "venv" / "bin" / "python"


def _setup_signature() -> str:
    req = _comfy_dir / "requirements.txt"
    h = hashlib.sha256()
    h.update(b"cu128-v1\n")
    if req.exists():
        h.update(req.read_bytes())
    return h.hexdigest()


def _run_setup_cmd(cmd: list[str]) -> None:
    print(f"[comfy_process] setup: {' '.join(cmd)}", flush=True)
    subprocess.run(
        cmd,
        cwd=str(_comfy_dir),
        stdout=_comfy_log_fh,
        stderr=_comfy_log_fh,
        check=True,
    )


def _ensure_environment() -> Path:
    global _installing
    py = _venv_python()
    req = _comfy_dir / "requirements.txt"
    marker = _comfy_dir / _SETUP_MARKER
    signature = _setup_signature()

    if py.exists() and marker.exists() and marker.read_text(encoding="utf-8", errors="replace") == signature:
        return py

    _installing = True
    try:
        if not py.exists():
            _run_setup_cmd([sys.executable, "-m", "venv", str(_comfy_dir / "venv")])

        _run_setup_cmd([str(py), "-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel"])
        _run_setup_cmd([
            str(py),
            "-m",
            "pip",
            "install",
            "--upgrade",
            "torch",
            "torchvision",
            "torchaudio",
            "--index-url",
            "https://download.pytorch.org/whl/cu128",
        ])
        if req.exists():
            _run_setup_cmd([str(py), "-m", "pip", "install", "-r", str(req)])
        marker.write_text(signature, encoding="utf-8")
        return py
    finally:
        _installing = False


def start() -> str:
    """Start the project-local ComfyUI process if enabled and not already reachable."""
    global _comfy_proc, _comfy_log_fh
    with _lock:
        if not _enabled:
            return "管理対象 ComfyUI は無効です。外部 ComfyUI に接続します。"
        if _is_http_ready():
            return f"ComfyUI は既に起動済みです。({get_url()})"
        if is_process_running():
            return f"ComfyUI を起動中です。({get_url()})"

        main_py = _comfy_dir / "main.py"
        if not main_py.exists():
            raise RuntimeError(
                f"ComfyUI が見つかりません: {_comfy_dir}\n"
                "runtime/ComfyUI に clone されているか確認してください。"
            )

        if _comfy_log_fh is not None:
            close_quietly(_comfy_log_fh)
        _comfy_log_fh = open(_COMFY_LOG, "w", encoding="utf-8", errors="replace")

        py = _ensure_environment()
        cmd = [
            str(py),
            str(main_py),
            "--listen",
            _host,
            "--port",
            str(_port),
            "--disable-auto-launch",
        ]

        env = os.environ.copy()
        env.setdefault("PYTORCH_CUDA_ALLOC_CONF", "backend:cudaMallocAsync")

        print(f"[comfy_process] Starting ComfyUI: {' '.join(cmd)}", flush=True)
        _comfy_proc = subprocess.Popen(
            cmd,
            cwd=str(_comfy_dir),
            stdout=_comfy_log_fh,
            stderr=_comfy_log_fh,
            creationflags=process_creationflags(),
            env=env,
        )
        _PID_FILE.write_text(str(_comfy_proc.pid), encoding="utf-8")
        return f"ComfyUI を起動しました。({get_url()})"


def start_background() -> None:
    if not _enabled:
        return
    threading.Thread(target=start, daemon=True).start()


def wait_until_ready(timeout: int = 600) -> None:
    """Wait for ComfyUI HTTP readiness and detect early process failure."""
    if not _enabled:
        return
    start()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _is_http_ready():
            return
        if _comfy_proc is not None and _comfy_proc.poll() is not None:
            log_tail = read_tail(_COMFY_LOG)
            raise RuntimeError(
                f"ComfyUI が異常終了しました（終了コード: {_comfy_proc.returncode}）。\n"
                f"ログ: {_COMFY_LOG}\n{log_tail}"
            )
        time.sleep(1)
    raise RuntimeError(f"ComfyUI の起動がタイムアウトしました（{timeout}秒）。ログ: {_COMFY_LOG}")


def stop() -> str:
    """Terminate the managed ComfyUI process. External processes are left alone."""
    global _comfy_proc, _comfy_log_fh
    with _lock:
        pid = _comfy_proc.pid if _comfy_proc is not None else _read_pid()
        if pid is not None:
            terminate_process_tree(_comfy_proc, pid=pid)
            _comfy_proc = None
        try:
            _PID_FILE.unlink()
        except FileNotFoundError:
            pass
        if _comfy_log_fh is not None:
            close_quietly(_comfy_log_fh)
            _comfy_log_fh = None
        return "ComfyUI を停止しました。"
