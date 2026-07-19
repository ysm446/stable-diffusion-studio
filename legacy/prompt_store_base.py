from __future__ import annotations

import re
import uuid
from typing import Any


class _SafeFormatDict(dict):
    def __missing__(self, key: str) -> str:
        return ""


def render_template(template: str, values: dict[str, Any]) -> str:
    safe = _SafeFormatDict({k: str(v or "") for k, v in values.items()})
    try:
        return template.format_map(safe)
    except Exception:
        return template


def make_slug(value: str, fallback_prefix: str) -> str:
    base = re.sub(r"[^a-zA-Z0-9_-]+", "-", value.strip()).strip("-").lower()
    return base or f"{fallback_prefix}-{uuid.uuid4().hex[:8]}"
