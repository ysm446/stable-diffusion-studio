from __future__ import annotations

from typing import Any

_state: dict[str, Any] = {
    "conversation_history": [],
    "current_image": None,        # PIL Image
    "current_image_stem": "",
    "current_image_path": "",
    "video_input_image": None,    # PIL Image
    "video_input_image_path": "",
    "current_video_path": "",
}

# token -> file path (for serving generated videos/files)
_temp_files: dict[str, str] = {}

_video_gen_id: int = 0


def next_video_gen_id() -> int:
    global _video_gen_id
    _video_gen_id += 1
    return _video_gen_id


def current_video_gen_id() -> int:
    return _video_gen_id
