from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from prompt_store_base import make_slug, render_template

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
PROMPTS_PATH = DATA_DIR / "caption_prompts.json"
# 旧保存先（data/library）。ライブラリのルートフォルダとは切り離すため data/ 直下へ移行する。
_LEGACY_PROMPTS_PATH = ROOT_DIR / "data" / "library" / "caption_prompts.json"
DEFAULT_PROMPT_VERSION = 2

DEFAULT_SYSTEM_BASE = """あなたは画像生成プロンプトの参照ライブラリを作るための画像キャプション担当です。提供された画像を観察し、後で類似画像検索やプロンプト生成に使いやすい説明文と検索用タグを作成してください。

出力は必ず JSON オブジェクトのみで返してください。Markdown、コードフェンス、前置き、補足説明は出力しないでください。

JSON schema:
{
  "caption": "画像の内容を日本語で説明する短い文章",
  "tags": ["検索に使いやすい日本語タグ"]
}

ルール:
- `caption` は日本語で、1〜3文の短い説明にしてください。
- `caption` には、画像に見える内容、被写体、構図、カメラ、光、色、質感、画風、雰囲気を具体的に含めてください。
- `tags` は 5〜12 個にしてください。
- `tags` には、具体物だけでなく上位概念も含めてください。例: パグなら「犬」「小型犬」「ペット」、ラブラドールレトリバーなら「犬」「大型犬」「ペット」。
- `tags` には、被写体、場所、行動、服装、色、スタイル、カテゴリ、検索しそうな同義語を優先してください。
- 見えない要素を断定しないでください。推測しすぎず、見えている要素を優先してください。
- JSON のキーは必ず `caption` と `tags` のみを使ってください。"""

DEFAULT_PROMPTS = [
    {
        "id": "visual",
        "name": "画像のみ",
        "system_prompt": DEFAULT_SYSTEM_BASE
        + "\n- 画像だけを根拠にしてください。既存プロンプト、ファイル名、メモは参照しないでください。"
        + "\n- 画像に見えない要素を、生成プロンプト由来の推測で補わないでください。",
        "user_prompt": "この画像をライブラリ登録用に説明し、検索用タグも生成してください。",
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "notes",
        "name": "画像 + メモ",
        "system_prompt": DEFAULT_SYSTEM_BASE
        + "\n- 画像を主な根拠にし、メモは補助情報としてのみ使ってください。"
        + "\n- メモに書かれていても画像に見えない要素は断定しないでください。",
        "user_prompt": "この画像をライブラリ登録用に説明し、検索用タグも生成してください。\n\nメモ:\n{notes}",
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "prompt_aware",
        "name": "画像 + プロンプト + メモ",
        "system_prompt": DEFAULT_SYSTEM_BASE
        + "\n- 画像を主な根拠にし、既存プロンプトとメモは補助情報として使ってください。"
        + "\n- 既存プロンプトに書かれていても画像に見えない要素は断定しないでください。",
        "user_prompt": (
            "この画像をライブラリ登録用に説明し、検索用タグも生成してください。\n\n"
            "既存 Positive Prompt:\n{positive_prompt}\n\n"
            "既存 Negative Prompt:\n{negative_prompt}\n\n"
            "メモ:\n{notes}"
        ),
        "created_at": 0,
        "updated_at": 0,
    },
]


def _migrate_legacy_file() -> None:
    """旧 data/library/caption_prompts.json を data/caption_prompts.json へ移す。"""
    if PROMPTS_PATH.exists() or not _LEGACY_PROMPTS_PATH.exists():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    try:
        _LEGACY_PROMPTS_PATH.replace(PROMPTS_PATH)
    except Exception:
        # 別ドライブ等で replace できない場合は内容コピーで代替
        PROMPTS_PATH.write_text(
            _LEGACY_PROMPTS_PATH.read_text(encoding="utf-8"), encoding="utf-8"
        )


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_file()
    if PROMPTS_PATH.exists():
        return
    now = time.time()
    prompts = [{**item, "created_at": now, "updated_at": now} for item in DEFAULT_PROMPTS]
    _write(prompts)


def _write(prompts: list[dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROMPTS_PATH.write_text(
        json.dumps(
            {"prompts": prompts, "default_prompt_version": DEFAULT_PROMPT_VERSION},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )


def _slug(value: str) -> str:
    return make_slug(value, "prompt")


def _merge_default_prompts(prompts: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], bool]:
    now = time.time()
    changed = False
    by_id = {str(prompt.get("id")): idx for idx, prompt in enumerate(prompts)}

    for default in DEFAULT_PROMPTS:
        prompt_id = default["id"]
        if prompt_id in by_id:
            idx = by_id[prompt_id]
            current = prompts[idx]
            created_at = current.get("created_at") or now
            next_item = {**default, "created_at": created_at, "updated_at": now}
            if any(current.get(key) != next_item.get(key) for key in ("name", "system_prompt", "user_prompt")):
                prompts[idx] = next_item
                changed = True
        else:
            prompts.append({**default, "created_at": now, "updated_at": now})
            changed = True

    return prompts, changed


def list_prompts() -> list[dict[str, Any]]:
    _ensure_file()
    try:
        data = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))
        prompts = data.get("prompts", [])
        default_prompt_version = int(data.get("default_prompt_version", 0) or 0)
        if not isinstance(prompts, list):
            prompts = []
        prompts = [p for p in prompts if isinstance(p, dict)]
    except Exception:
        prompts = []
        default_prompt_version = 0

    if not prompts:
        prompts = [{**item, "created_at": time.time(), "updated_at": time.time()} for item in DEFAULT_PROMPTS]
        _write(prompts)
        return prompts

    if default_prompt_version < DEFAULT_PROMPT_VERSION:
        prompts, changed = _merge_default_prompts(prompts)
    else:
        changed = False
    if changed or default_prompt_version != DEFAULT_PROMPT_VERSION:
        _write(prompts)
    return prompts


def get_prompt(prompt_id: str) -> dict[str, Any] | None:
    return next((p for p in list_prompts() if p.get("id") == prompt_id), None)


def save_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    prompts = list_prompts()
    now = time.time()
    explicit_id = str(payload.get("id") or "").strip()
    prompt_id = explicit_id or _slug(str(payload.get("name") or "caption-prompt"))
    existing_ids = {str(p.get("id")) for p in prompts}
    # 新規作成（ID 未指定）でスラッグが既存と衝突した場合はサフィックスで一意化する
    if not explicit_id and prompt_id in existing_ids:
        base = prompt_id
        i = 2
        while prompt_id in existing_ids:
            prompt_id = f"{base}-{i}"
            i += 1

    item = {
        "id": prompt_id,
        "name": str(payload.get("name") or prompt_id).strip() or prompt_id,
        "system_prompt": str(payload.get("system_prompt") or "").strip(),
        "user_prompt": str(payload.get("user_prompt") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    if not item["system_prompt"]:
        raise ValueError("system_prompt は必須です")
    if not item["user_prompt"]:
        raise ValueError("user_prompt は必須です")

    replaced = False
    for idx, prompt in enumerate(prompts):
        if prompt.get("id") == prompt_id:
            item["created_at"] = prompt.get("created_at") or now
            prompts[idx] = item
            replaced = True
            break
    if not replaced:
        prompts.append(item)
    _write(prompts)
    return item


def delete_prompt(prompt_id: str) -> None:
    prompts = [p for p in list_prompts() if p.get("id") != prompt_id]
    if not prompts:
        prompts = [{**item, "created_at": time.time(), "updated_at": time.time()} for item in DEFAULT_PROMPTS]
    _write(prompts)
