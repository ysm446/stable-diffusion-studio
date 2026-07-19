"""アプリ設定 (settings.json) の読み書き。"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
SETTINGS_PATH = BASE_DIR / "settings.json"

_lock = threading.Lock()


def load() -> dict[str, Any]:
    try:
        with SETTINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save(settings: dict[str, Any]) -> None:
    with _lock:
        tmp = SETTINGS_PATH.with_name(SETTINGS_PATH.name + ".tmp")
        tmp.write_text(
            json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        tmp.replace(SETTINGS_PATH)


def update(patch: dict[str, Any]) -> dict[str, Any]:
    settings = load()
    settings.update(patch)
    save(settings)
    return settings
