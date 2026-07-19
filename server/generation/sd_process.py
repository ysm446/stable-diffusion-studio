"""
sd_process.py
Project-local Stable Diffusion WebUI Forge process management.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import requests

from server.generation.managed_process import (
    close_quietly,
    env_enabled,
    process_creationflags,
    read_tail,
    resolve_dir,
    terminate_process_tree,
)

_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
_DEFAULT_FORGE_DIR = _ROOT_DIR / "runtime" / "stable-diffusion-webui-forge"
_FORGE_LOG = _ROOT_DIR / "forge_server.log"

_lock = threading.RLock()
_forge_proc: subprocess.Popen | None = None
_forge_log_fh: Any = None
_forge_dir: Path = Path(os.getenv("SD_FORGE_DIR", str(_DEFAULT_FORGE_DIR)))
_host = os.getenv("SD_FORGE_HOST", "127.0.0.1")
_port = int(os.getenv("SD_FORGE_PORT", "7861"))
_enabled = env_enabled("SD_MANAGED_FORGE")


def _migrate_forge_config_paths() -> bool:
    """Forge の設定に残る旧 bin 配下の絶対パスを現在の配置先へ移行する。"""
    config_path = _forge_dir / "config.json"
    if not config_path.exists():
        return False

    legacy_dir = _ROOT_DIR / "bin" / "stable-diffusion-webui-forge"
    replacements = (
        (str(legacy_dir), str(_forge_dir)),
        (legacy_dir.as_posix(), _forge_dir.as_posix()),
    )

    def migrate(value: Any) -> Any:
        if isinstance(value, str):
            for old, new in replacements:
                value = value.replace(old, new)
            return value
        if isinstance(value, list):
            return [migrate(item) for item in value]
        if isinstance(value, dict):
            return {key: migrate(item) for key, item in value.items()}
        return value

    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        migrated = migrate(config)
        if migrated == config:
            return False
        temp_path = config_path.with_suffix(".json.tmp")
        temp_path.write_text(
            json.dumps(migrated, ensure_ascii=False, indent=4) + "\n",
            encoding="utf-8",
        )
        os.replace(temp_path, config_path)
        return True
    except (OSError, ValueError, TypeError) as exc:
        print(f"[sd_process] Forge 設定パスの移行に失敗しました: {exc}", flush=True)
        return False


def configure(settings: dict[str, Any]) -> None:
    """Apply settings/env overrides before starting Forge."""
    global _forge_dir, _host, _port, _enabled
    with _lock:
        if os.getenv("SD_MANAGED_FORGE") is not None:
            _enabled = env_enabled("SD_MANAGED_FORGE")
        else:
            _enabled = bool(settings.get("managed_forge_enabled", _enabled))
        _forge_dir = resolve_dir(
            _ROOT_DIR,
            os.getenv("SD_FORGE_DIR")
            or settings.get("managed_forge_dir")
            or str(_DEFAULT_FORGE_DIR),
        )
        _host = str(os.getenv("SD_FORGE_HOST") or settings.get("managed_forge_host") or "127.0.0.1")
        _port = int(os.getenv("SD_FORGE_PORT") or settings.get("managed_forge_port") or 7861)


def get_url() -> str:
    return f"http://{_host}:{_port}"


def is_enabled() -> bool:
    return _enabled


def is_process_running() -> bool:
    return _forge_proc is not None and _forge_proc.poll() is None


def _is_http_ready() -> bool:
    try:
        resp = requests.get(f"{get_url()}/config", timeout=3)
        return resp.status_code == 200
    except Exception:
        return False


def is_ready() -> bool:
    return _is_http_ready()


def status() -> dict[str, Any]:
    return {
        "enabled": _enabled,
        "url": get_url(),
        "dir": str(_forge_dir),
        "process_running": is_process_running(),
        "ready": is_ready(),
        "log": str(_FORGE_LOG),
        "returncode": None if _forge_proc is None else _forge_proc.poll(),
    }


def start() -> str:
    """Start the project-local Forge process if enabled and not already reachable."""
    global _forge_proc, _forge_log_fh
    with _lock:
        if not _enabled:
            return "管理対象 Forge は無効です。外部 Forge に接続します。"
        _migrate_forge_config_paths()
        if _is_http_ready():
            return f"Forge は既に起動済みです。({get_url()})"
        if is_process_running():
            return f"Forge を起動中です。({get_url()})"

        webui_bat = _forge_dir / "webui.bat"
        if not webui_bat.exists():
            raise RuntimeError(
                f"WebUI Forge が見つかりません: {_forge_dir}\n"
                "runtime/stable-diffusion-webui-forge に clone されているか確認してください。"
            )

        cmd = [
            "cmd.exe",
            "/c",
            str(webui_bat),
            "--server-name",
            _host,
            "--port",
            str(_port),
        ]

        if _forge_log_fh is not None:
            close_quietly(_forge_log_fh)
        _forge_log_fh = open(_FORGE_LOG, "w", encoding="utf-8", errors="replace")

        print(f"[sd_process] Starting Forge: {' '.join(cmd)}", flush=True)
        env = os.environ.copy()
        env.pop("VENV_DIR", None)
        env.pop("VIRTUAL_ENV", None)
        app_venv_scripts = str(_ROOT_DIR / ".venv" / "Scripts").lower()
        env["PATH"] = os.pathsep.join(
            part
            for part in env.get("PATH", "").split(os.pathsep)
            if part and part.rstrip("\\/").lower() != app_venv_scripts
        )
        forge_venv_dir = _forge_dir / "venv"
        forge_venv_python = forge_venv_dir / "Scripts" / "python.exe"
        if forge_venv_python.exists():
            env["VENV_DIR"] = str(forge_venv_dir)
            env["PYTHON"] = str(forge_venv_python)
        elif os.getenv("SD_FORGE_PYTHON"):
            env["PYTHON"] = os.environ["SD_FORGE_PYTHON"]
        elif shutil.which("py", path=env.get("PATH")):
            env.setdefault("PYTHON", "py -3.10")
        env.setdefault("TORCH_INDEX_URL", "https://download.pytorch.org/whl/cu128")
        env.setdefault(
            "TORCH_COMMAND",
            "pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128",
        )
        _forge_proc = subprocess.Popen(
            cmd,
            cwd=str(_forge_dir),
            stdout=_forge_log_fh,
            stderr=_forge_log_fh,
            creationflags=process_creationflags(),
            env=env,
        )
        return f"Forge を起動しました。({get_url()})"


def start_background() -> None:
    if not _enabled:
        return
    threading.Thread(target=start, daemon=True).start()


def wait_until_ready(timeout: int = 600) -> None:
    """Wait for Forge HTTP readiness and detect early process failure."""
    if not _enabled:
        return
    start()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if _is_http_ready():
            return
        if _forge_proc is not None and _forge_proc.poll() is not None:
            log_tail = read_tail(_FORGE_LOG)
            raise RuntimeError(
                f"Forge が異常終了しました（終了コード: {_forge_proc.returncode}）。\n"
                f"ログ: {_FORGE_LOG}\n{log_tail}"
            )
        time.sleep(1)
    raise RuntimeError(f"Forge の起動がタイムアウトしました（{timeout}秒）。ログ: {_FORGE_LOG}")


def stop() -> str:
    """Terminate the managed Forge process. External processes are left alone."""
    global _forge_proc, _forge_log_fh
    with _lock:
        if _forge_proc is not None:
            if _forge_proc.poll() is None:
                terminate_process_tree(_forge_proc)
            _forge_proc = None
        if _forge_log_fh is not None:
            close_quietly(_forge_log_fh)
            _forge_log_fh = None
        return "Forge を停止しました。"
