"""
llm_client.py
llama-server サブプロセスを起動し、OpenAI 互換 API で推論するクライアント。
llama-server.exe のパスは環境変数 LLAMA_SERVER_EXE で指定。未指定時は runtime/llama-server/ 内の
最新サブディレクトリ（名前の降順）にある llama-server.exe を自動選択する。
"""

from __future__ import annotations

import base64
import io
import json
import os
import re
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

import requests
from PIL import Image

_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
_MODELS_DIR = _ROOT_DIR / "models"
_SERVER_LOG = _ROOT_DIR / "llama_server.log"

def _find_llama_server_exe() -> Path:
    """runtime/llama-server/ 内のサブディレクトリを名前の降順でソートし、最初に見つかった llama-server.exe を返す。"""
    env_path = os.getenv("LLAMA_SERVER_EXE")
    if env_path:
        return Path(env_path)
    search_dir = _ROOT_DIR / "runtime" / "llama-server"
    if search_dir.is_dir():
        candidates = sorted(
            (d / "llama-server.exe" for d in search_dir.iterdir() if d.is_dir()),
            key=lambda p: p.parent.name,
            reverse=True,
        )
        for candidate in candidates:
            if candidate.exists():
                return candidate
    # フォールバック（存在チェックは起動時に行う）
    return search_dir / "llama-server.exe"

_LLAMA_SERVER_EXE = _find_llama_server_exe()

_SERVER_HOST = "127.0.0.1"
_SERVER_PORT = int(os.getenv("LLAMA_SERVER_PORT", "8090"))
_SERVER_BASE_URL = f"http://{_SERVER_HOST}:{_SERVER_PORT}"

_DEFAULT_N_CTX      = int(os.getenv("LLAMA_N_CTX",    "8192"))
_DEFAULT_MAX_TOKENS = int(os.getenv("LLAMA_MAX_TOKENS", "4096"))

_last_usage: dict[str, Any] | None = None
_last_messages: list[dict[str, Any]] = []

# ---------------------------------------------------------------------------
# Model discovery
# ---------------------------------------------------------------------------

MODEL_PRESETS: dict[str, str] = {}
_MODEL_CONFIGS: dict[str, dict[str, Any]] = {}

_server_proc: subprocess.Popen | None = None
_server_log_fh: Any = None   # ログファイルハンドル
_loaded_model_id: str | None = None
_lock = threading.RLock()
_generation_lock = threading.Lock()


def _find_mmproj(model_path: Path) -> Path | None:
    """同じディレクトリ内の mmproj GGUF を探す。"""
    parent = model_path.parent
    # "mmproj" で始まるファイル、または ".mmproj" を含むファイルを検索
    for pattern in ("mmproj*.gguf", "*.mmproj*.gguf"):
        candidates = sorted(parent.glob(pattern))
        if candidates:
            return candidates[0]
    return None


def _discover_model_configs() -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    presets: dict[str, str] = {}
    configs: dict[str, dict[str, Any]] = {}

    if not _MODELS_DIR.is_dir():
        return presets, configs

    # models/ 以下のすべての GGUF（mmproj を除く）を対象にする
    gguf_paths = sorted(
        p for p in _MODELS_DIR.rglob("*.gguf")
        if "mmproj" not in p.name.lower()
        and "embedding" not in p.name.lower()
        and "embedding" not in p.parent.name.lower()
    )

    used_labels: set[str] = set()
    for model_path in gguf_paths:
        mmproj_path = _find_mmproj(model_path)

        label = model_path.stem
        if label in used_labels:
            label = model_path.relative_to(_MODELS_DIR).with_suffix("").as_posix()
        used_labels.add(label)

        presets[label] = label
        configs[label] = {
            "model_path": str(model_path),
            "mmproj_path": str(mmproj_path) if mmproj_path else None,
            "has_vision": mmproj_path is not None,
        }

    return presets, configs


def refresh_model_presets() -> dict[str, str]:
    global MODEL_PRESETS, _MODEL_CONFIGS
    with _lock:
        MODEL_PRESETS, _MODEL_CONFIGS = _discover_model_configs()
        return MODEL_PRESETS.copy()


def _ensure_model_configs() -> None:
    if not MODEL_PRESETS:
        refresh_model_presets()


# ---------------------------------------------------------------------------
# Server process management
# ---------------------------------------------------------------------------

def _wait_for_server(timeout: int = 120) -> None:
    """llama-server が /health で 200 を返すまで待機する。プロセス死亡も検出する。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1)

        # プロセスが死んでいたら即座に失敗
        if _server_proc is not None and _server_proc.poll() is not None:
            log_tail = ""
            try:
                log_tail = _SERVER_LOG.read_text(encoding="utf-8", errors="replace")[-2000:]
            except Exception:
                pass
            raise RuntimeError(
                f"llama-server が異常終了しました（終了コード: {_server_proc.returncode}）。\n"
                f"ログ: {_SERVER_LOG}\n{log_tail}"
            )

        try:
            r = requests.get(f"{_SERVER_BASE_URL}/health", timeout=3)
            if r.status_code == 200:
                return
        except Exception:
            pass

    raise RuntimeError(
        f"llama-server の起動がタイムアウトしました（{timeout}秒）。\n"
        f"ログを確認してください: {_SERVER_LOG}"
    )


def _stop_server() -> None:
    global _server_proc, _server_log_fh, _loaded_model_id
    if _server_proc is not None:
        _server_proc.terminate()
        try:
            _server_proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            _server_proc.kill()
        _server_proc = None
    if _server_log_fh is not None:
        try:
            _server_log_fh.close()
        except Exception:
            pass
        _server_log_fh = None
    _loaded_model_id = None


def _start_server(model_path: str, mmproj_path: str | None) -> None:
    global _server_proc, _server_log_fh

    if not _LLAMA_SERVER_EXE.exists():
        raise RuntimeError(
            f"llama-server.exe が見つかりません: {_LLAMA_SERVER_EXE}\n"
            "環境変数 LLAMA_SERVER_EXE で正しいパスを指定してください。"
        )

    _stop_server()

    cmd: list[str] = [
        str(_LLAMA_SERVER_EXE),
        "--model", model_path,
        "--host", _SERVER_HOST,
        "--port", str(_SERVER_PORT),
        "--n-gpu-layers", "-1",
        "--ctx-size", str(_DEFAULT_N_CTX),
    ]
    if mmproj_path:
        cmd += ["--mmproj", mmproj_path]

    print(f"[llm_client] Starting llama-server: {' '.join(cmd)}", flush=True)

    _server_log_fh = open(_SERVER_LOG, "w", encoding="utf-8")
    _server_proc = subprocess.Popen(
        cmd,
        stdout=_server_log_fh,
        stderr=_server_log_fh,
        creationflags=subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0,
    )

    _wait_for_server()


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def is_loaded() -> bool:
    if _server_proc is None or _loaded_model_id is None:
        return False
    # プロセスが終了していないか確認
    if _server_proc.poll() is not None:
        return False
    return True


def get_status() -> dict[str, Any]:
    """ステータスバー向けにローカル LLM のロード状態を返す。"""
    with _lock:
        loaded = is_loaded()
        return {
            "enabled": True,
            "ready": loaded,
            "process_running": _server_proc is not None and _server_proc.poll() is None,
            "model": _loaded_model_id if loaded else None,
            "url": _SERVER_BASE_URL,
            "n_ctx": _DEFAULT_N_CTX,
        }


def _parse_log_mib(pattern: str, text: str) -> float:
    matches = re.findall(pattern, text, flags=re.MULTILINE)
    return round(sum(float(value) for value in matches), 1) if matches else 0.0


def _parse_log_max_mib(pattern: str, text: str) -> float:
    matches = re.findall(pattern, text, flags=re.MULTILINE)
    return round(max(float(value) for value in matches), 1) if matches else 0.0


def get_vram_debug() -> dict[str, Any]:
    with _lock:
        pid = _server_proc.pid if _server_proc is not None and _server_proc.poll() is None else None
        if pid is None:
            return {
                "pid": None,
                "model": None,
                "n_ctx": _DEFAULT_N_CTX,
                "log": str(_SERVER_LOG),
                "parts_mib": {},
            }
        log_text = ""
        try:
            log_text = _SERVER_LOG.read_text(encoding="utf-8", errors="replace")
        except Exception:
            pass

        prompt_cache = 0.0
        cache_matches = re.findall(r"cache state:\s+\d+\s+prompts,\s+([0-9.]+)\s+MiB", log_text)
        if cache_matches:
            prompt_cache = float(cache_matches[-1])

        return {
            "pid": pid,
            "model": _loaded_model_id,
            "n_ctx": _DEFAULT_N_CTX,
            "log": str(_SERVER_LOG),
            "parts_mib": {
                "model_gpu": _parse_log_mib(r"CUDA\d+ model buffer size =\s+([0-9.]+)\s+MiB", log_text),
                "model_cpu_mapped": _parse_log_mib(r"CPU_Mapped model buffer size =\s+([0-9.]+)\s+MiB", log_text),
                "kv_cache": _parse_log_mib(r"CUDA\d+ KV buffer size =\s+([0-9.]+)\s+MiB", log_text),
                "compute": _parse_log_max_mib(r"CUDA\d+ compute buffer size =\s+([0-9.]+)\s+MiB", log_text),
                "prompt_cache": round(prompt_cache, 1),
            },
        }


def unload_model() -> str:
    """llama-server を停止してメモリを解放する。"""
    with _lock:
        if not is_loaded():
            return "llama-server は起動していません。"
        _stop_server()
        return "llama-server を停止しました。"


def load_model(model_id: str) -> str:
    """
    指定モデルで llama-server を起動する。
    既に同じモデルが動いている場合はスキップ。
    """
    global _loaded_model_id

    with _lock:
        _ensure_model_configs()
        config = _MODEL_CONFIGS.get(model_id)
        if config is None:
            raise RuntimeError(
                f"モデル '{model_id}' が見つかりません。models/ 配下を確認してください。"
            )

        if is_loaded() and _loaded_model_id == model_id:
            return f"モデル {model_id} は既に起動済みです。"

        model_path = config["model_path"]
        mmproj_path = config["mmproj_path"]

        try:
            _start_server(model_path, mmproj_path)
            _loaded_model_id = model_id
            vision_note = "（vision 対応）" if config["has_vision"] else "（テキストのみ）"
            return f"llama-server: {model_id} {vision_note} 起動完了。"
        except Exception as e:
            _stop_server()
            raise RuntimeError(f"llama-server の起動に失敗しました: {e}") from e


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------

def _image_to_data_url(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    encoded = base64.b64encode(buf.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def _to_content_blocks(
    text: str,
    image: Image.Image | None = None,
    include_image: bool = True,
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    if image is not None and include_image:
        content.append({
            "type": "image_url",
            "image_url": {"url": _image_to_data_url(image)},
        })
    content.append({"type": "text", "text": text})
    return content


def _normalize_history_message(message: dict[str, Any], include_images: bool) -> dict[str, Any]:
    role = message.get("role", "user")
    content = message.get("content", "")

    if isinstance(content, str):
        return {"role": role, "content": content}

    if isinstance(content, list):
        blocks: list[dict[str, Any]] = []
        for part in content:
            if not isinstance(part, dict):
                continue
            part_type = part.get("type")
            if part_type == "text":
                blocks.append({"type": "text", "text": part.get("text", "")})
            elif part_type == "image" and include_images:
                image = part.get("image")
                if isinstance(image, Image.Image):
                    blocks.append({
                        "type": "image_url",
                        "image_url": {"url": _image_to_data_url(image)},
                    })
            elif part_type == "image_url" and include_images:
                image_url = part.get("image_url")
                if isinstance(image_url, str):
                    blocks.append({"type": "image_url", "image_url": {"url": image_url}})
                elif isinstance(image_url, dict) and image_url.get("url"):
                    blocks.append({"type": "image_url", "image_url": image_url})
        return {"role": role, "content": blocks or ""}

    return {"role": role, "content": str(content)}


def _extract_delta_text(chunk: dict[str, Any]) -> str:
    choices = chunk.get("choices") or []
    if not choices:
        return ""
    choice = choices[0]
    delta = choice.get("delta") or {}
    content = delta.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict) and part.get("type") == "text"
        )
    message = choice.get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    return ""


def _filter_thinking(stream):
    """
    ストリームから <think>...</think> ブロックを除去するジェネレーター。
    Qwen3 系の thinking モードで余計な思考過程をユーザーに見せないようにする。
    """
    in_think = False
    buf = ""

    for token in stream:
        buf += token

        while True:
            if in_think:
                end = buf.find("</think>")
                if end >= 0:
                    in_think = False
                    buf = buf[end + len("</think>"):]
                    # </think> 直後の改行を 1 つ飛ばす
                    if buf.startswith("\n"):
                        buf = buf[1:]
                else:
                    # まだ thinking 中 — 末尾の不完全タグ候補だけ残す
                    keep = min(len(buf), len("</think>") - 1)
                    buf = buf[-keep:] if keep else ""
                    break
            else:
                start = buf.find("<think>")
                if start >= 0:
                    if start > 0:
                        yield buf[:start]
                    in_think = True
                    buf = buf[start + len("<think>"):]
                else:
                    # <think> の先頭が来ているかもしれない末尾を保留
                    safe = max(0, len(buf) - (len("<think>") - 1))
                    if safe > 0:
                        yield buf[:safe]
                        buf = buf[safe:]
                    break

    # ストリーム終了後に残ったバッファを出力（thinking 外のみ）
    if buf and not in_think:
        yield buf


def _stream_chat(messages: list[dict[str, Any]], max_tokens: int):
    """llama-server の /v1/chat/completions SSE をストリーミングで yield する。"""
    global _last_usage, _last_messages
    _last_messages = messages
    payload = {
        "messages": messages,
        "temperature": 0.2,
        "top_p": 0.95,
        "max_tokens": max_tokens,
        "stream": True,
        "stream_options": {"include_usage": True},
        "chat_template_kwargs": {"enable_thinking": False},
    }

    with _generation_lock:
        with requests.post(
            f"{_SERVER_BASE_URL}/v1/chat/completions",
            json=payload,
            stream=True,
            timeout=180,
        ) as resp:
            resp.raise_for_status()
            for raw_line in resp.iter_lines():
                if not raw_line:
                    continue
                line = raw_line.decode("utf-8") if isinstance(raw_line, bytes) else raw_line
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    if chunk.get("usage"):
                        _last_usage = chunk["usage"]
                    text = _extract_delta_text(chunk)
                    if text:
                        yield text
                except json.JSONDecodeError:
                    pass


def get_last_usage() -> dict[str, Any] | None:
    return _last_usage


def get_last_messages() -> list[dict[str, Any]]:
    return _last_messages


def _current_has_vision() -> bool:
    if _loaded_model_id is None:
        return False
    config = _MODEL_CONFIGS.get(_loaded_model_id, {})
    return bool(config.get("has_vision"))


# ---------------------------------------------------------------------------
# Public inference functions
# ---------------------------------------------------------------------------

def query_stream(
    conversation_history: list[dict],
    user_input: str,
    current_image: Image.Image | None,
    positive_prompt: str,
    negative_prompt: str,
    system_prompt: str | None = None,
    max_tokens: int | None = None,
):
    """
    llama-server にストリーミングで問い合わせ、トークンを逐次 yield する。
    system_prompt が None の場合はデフォルトのプロンプトエンジニアリング指示を使用する。
    """
    if not is_loaded():
        raise RuntimeError("モデルがロードされていません。先にモデルをロードしてください。")

    has_vision = _current_has_vision()

    if system_prompt is None:
        system_prompt = (
            "あなたは画像生成のプロンプトエンジニアリングの専門家です。\n"
            "ユーザーの意図を理解し、Stable Diffusion 向けの高品質なプロンプトを提案してください。\n\n"
            f"現在のプロンプト:\nPositive: {positive_prompt}\nNegative: {negative_prompt}"
        )

    messages: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
    messages.extend(
        _normalize_history_message(m, include_images=has_vision)
        for m in conversation_history
    )
    messages.append({
        "role": "user",
        "content": _to_content_blocks(user_input, current_image, include_image=has_vision),
    })

    yield from _filter_thinking(_stream_chat(messages, max_tokens=max_tokens or _DEFAULT_MAX_TOKENS))


_SECTION_TEMPLATES = {
    "scene":  "**Scene**: [Describe the visual scene in detail based on the image]",
    "action": "**Action**: [Describe the motion/movement to add - be specific about what moves and how]",
    "camera": "**Camera**: [Describe camera movement: static, slow pan, zoom in/out, dolly, tracking, etc.]",
    "style":  "**Style**: [Describe the visual style and mood]",
    "prompt": (
        "---\n**Final Prompt for WAN 2.2**:\n"
        "[Write a single paragraph combining all elements. "
        "This should be copy-paste ready for WAN 2.2. "
        "Write in English, be concise but descriptive. "
        "Focus on motion and cinematic qualities.]"
    ),
}
_ALL_SECTIONS = list(_SECTION_TEMPLATES.keys())

_VIDEO_SYSTEM_PROMPT_TEMPLATE = """\
あなたはWan2.2動画生成のプロンプトエンジニアリングの専門家です。
提供された画像・画像プロンプト・追加指示を元に、以下のセクションを順番に出力してください。

現在の画像プロンプト: {positive_prompt}

出力するセクション（指定されたものだけ出力してください）:
{sections_text}

ルール:
- 指定されたセクションのみを出力してください（他のセクション・前置き・コメント不要）
- 各セクションは簡潔に1-2文で書いてください。
- 英語で記述してください
- 動きや変化・雰囲気を具体的に記述してください
"""


def generate_video_prompt_stream(
    image: Image.Image | None,
    positive_prompt: str,
    extra_instruction: str,
    sections: list[str] | None = None,
):
    """
    画像・画像プロンプト・追加指示から動画用プロンプトをストリーミング生成する。
    """
    if not is_loaded():
        raise RuntimeError("モデルがロードされていません。先にモデルをロードしてください。")

    has_vision = _current_has_vision()

    active_sections = sections if sections else _ALL_SECTIONS
    sections_text = "\n".join(
        _SECTION_TEMPLATES[name] for name in _ALL_SECTIONS if name in active_sections
    )
    system_content = _VIDEO_SYSTEM_PROMPT_TEMPLATE.format(
        positive_prompt=positive_prompt,
        sections_text=sections_text,
    )
    user_text = f"追加指示: {extra_instruction}\n\n動画プロンプトを生成してください。"
    messages = [
        {"role": "system", "content": system_content},
        {
            "role": "user",
            "content": _to_content_blocks(user_text, image, include_image=has_vision),
        },
    ]

    yield from _filter_thinking(_stream_chat(messages, max_tokens=1024))


def generate_library_caption_stream(
    image: Image.Image,
    system_prompt: str,
    user_prompt: str,
):
    """
    画像ライブラリ用に、画像の内容・構図・画風を検索しやすい説明文として生成する。
    """
    if not is_loaded():
        raise RuntimeError("モデルがロードされていません。先にモデルをロードしてください。")

    has_vision = _current_has_vision()
    if not has_vision:
        raise RuntimeError("現在ロードされているモデルは Vision に対応していません。")

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": _to_content_blocks(user_prompt, image, include_image=has_vision),
        },
    ]

    yield from _filter_thinking(_stream_chat(messages, max_tokens=768))


# 起動時にモデル一覧を構築
refresh_model_presets()
