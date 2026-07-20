"""外部動画ファイルの取り込み（メタデータ抽出つき）。

ドロップされた動画をアイテムに登録する際、ffprobe で解像度・fps・尺・
埋め込みタグ（ComfyUI/VHS が書き込むプロンプト等）を読み取り、生成済み動画と
同じ ``settings`` として保存する。
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any

_CREATE_NO_WINDOW = 0x08000000

# 埋め込みタグから動画プロンプトとして拾う候補キー
_PROMPT_TAG_KEYS = ("prompt", "description", "comment")


def _run(cmd: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW,
    )


def probe(video_bytes: bytes, ext: str = ".mp4") -> dict[str, Any]:
    """動画バイト列を ffprobe し、settings 用の情報とプロンプト候補を返す。

    ffprobe が無い／失敗しても例外にせず、空の結果を返す（取り込み自体は続行）。
    Returns: {"settings": {...}, "prompt": str}
    """
    settings: dict[str, Any] = {}
    prompt = ""
    tmp = None
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as f:
            f.write(video_bytes)
            tmp = f.name
        proc = _run(
            [
                "ffprobe", "-v", "error",
                "-show_entries",
                "format=duration:format_tags:stream=codec_name,width,height,r_frame_rate",
                "-of", "json",
                tmp,
            ]
        )
        if proc.returncode != 0:
            return {"settings": settings, "prompt": prompt}
        data = json.loads(proc.stdout or "{}")
        fmt = data.get("format") or {}
        streams = data.get("streams") or []
        vstream = next((s for s in streams if s.get("width")), streams[0] if streams else {})
        if vstream.get("width"):
            settings["width"] = int(vstream["width"])
        if vstream.get("height"):
            settings["height"] = int(vstream["height"])
        num, _, den = (vstream.get("r_frame_rate") or "0/1").partition("/")
        try:
            fps = float(num) / float(den or 1)
            if fps > 0:
                settings["fps"] = round(fps, 3)
        except (ValueError, ZeroDivisionError):
            pass
        try:
            if fmt.get("duration"):
                settings["duration"] = round(float(fmt["duration"]), 2)
        except (ValueError, TypeError):
            pass

        # 埋め込みタグ（ComfyUI/VHS のワークフロー・プロンプト等）
        tags = {str(k).lower(): v for k, v in (fmt.get("tags") or {}).items()}
        for key in _PROMPT_TAG_KEYS:
            if tags.get(key):
                candidate = str(tags[key]).strip()
                # JSON（ワークフロー丸ごと）はプロンプトにせず metadata に残す
                if candidate and not candidate.startswith("{"):
                    prompt = candidate
                    break
        if tags:
            settings["metadata"] = tags
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    finally:
        if tmp:
            Path(tmp).unlink(missing_ok=True)
    return {"settings": settings, "prompt": prompt}
