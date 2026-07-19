"""
managed_process.py
Shared helpers for app-owned local backend processes.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

try:
    import psutil as _psutil
except ImportError:
    _psutil = None


def env_enabled(name: str, default: bool = True) -> bool:
    fallback = "1" if default else "0"
    return os.getenv(name, fallback).lower() not in {"0", "false", "no"}


def resolve_dir(root: Path, value: str | os.PathLike[str]) -> Path:
    path = Path(value)
    return path if path.is_absolute() else (root / path).resolve()


def process_creationflags() -> int:
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags |= subprocess.CREATE_NO_WINDOW
    if hasattr(subprocess, "CREATE_NEW_PROCESS_GROUP"):
        flags |= subprocess.CREATE_NEW_PROCESS_GROUP
    return flags


def close_quietly(handle: Any) -> None:
    if handle is None:
        return
    try:
        handle.close()
    except Exception:
        pass


def read_tail(path: Path, chars: int = 3000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[-chars:]
    except Exception:
        return ""


def pid_exists(pid: int | None) -> bool:
    if pid is None or _psutil is None:
        return False
    return _psutil.pid_exists(pid)


def terminate_process_tree(
    proc: subprocess.Popen | None = None,
    pid: int | None = None,
    timeout: int = 20,
) -> None:
    target_pid = proc.pid if proc is not None else pid
    if target_pid is None:
        return

    if _psutil is not None:
        try:
            parent = _psutil.Process(target_pid)
            children = parent.children(recursive=True)
            for child in children:
                child.terminate()
            parent.terminate()
            _, alive = _psutil.wait_procs([parent, *children], timeout=timeout)
            for live_proc in alive:
                live_proc.kill()
        except _psutil.Error:
            pass
        return

    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)
