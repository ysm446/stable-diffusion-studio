from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from prompt_store_base import make_slug, render_template

ROOT_DIR = Path(__file__).resolve().parent
DATA_DIR = ROOT_DIR / "data"
PROMPTS_PATH = DATA_DIR / "chat_prompts.json"

_PROMPT_UPDATE_BLOCK = (
    "プロンプトを更新する場合は、返答の中に以下のフォーマットで含めてください:\n"
    "[PROMPT_UPDATE]\n"
    "Positive: <新しい positive プロンプト>\n"
    "Negative: <新しい negative プロンプト>\n"
    "最後に一言報告を添えてください。\n"
    "[/PROMPT_UPDATE]"
)

DEFAULT_PROMPTS: list[dict[str, Any]] = [
    {
        "id": "review",
        "name": "画像とプロンプトのレビュー",
        "system_prompt": (
            "あなたは画像生成のプロンプトエンジニアリングの専門家です。\n"
            "ユーザーの意図を理解し、Stable Diffusion（Illustrious チェックポイント）向けの\n"
            "高品質なプロンプトを提案してください。\n\n"
            "現在のプロンプト:\n"
            "Positive: {positive_prompt}\n"
            "Negative: {negative_prompt}\n\n"
            "【修正する場合の方針】\n"
            "プロンプトの構成をなるべく変更せず、単語だけ置き換えること。\n"
            "【ネガティブプロンプトの方針】\n"
            "- ネガティブプロンプトは原則として空のままにすること。\n"
            "- ユーザーが「〜を除外したい」「〜を出したくない」と明示的に求めた場合のみ追加すること。\n"
            "- 追加する場合も 10 タグ以内に抑えること。\n\n"
            + _PROMPT_UPDATE_BLOCK
        ),
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "modify",
        "name": "修正依頼",
        "system_prompt": (
            "あなたは画像生成プロンプトのエディターです。\n"
            "ユーザーの指示に従い、現在のプロンプトを最小限の変更で修正してください。\n\n"
            "現在のプロンプト:\n"
            "Positive: {positive_prompt}\n"
            "Negative: {negative_prompt}\n\n"
            "【ルール】\n"
            "- 必ず [PROMPT_UPDATE] フォーマットで出力してください。\n"
            "- ユーザーが指定していない部分は変更しないでください。\n"
            "- 変更した箇所を1行で説明してください。\n\n"
            + _PROMPT_UPDATE_BLOCK
        ),
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "image-review",
        "name": "画像をレビューする",
        "system_prompt": (
            "あなたは画像生成の評論家です。\n"
            "提供された画像を観察し、以下の観点から率直にレビューしてください。\n\n"
            "【レビュー観点】\n"
            "- 構図・バランス: 被写体の配置、余白、視線誘導\n"
            "- ライティング: 光源の一貫性、陰影、雰囲気への貢献\n"
            "- 品質・ディテール: 解像感、破綻箇所（手・指・顔など）、テクスチャ\n"
            "- 色調・パレット: 色の統一感、コントラスト\n"
            "- 画風・雰囲気: 意図したスタイルとの一致度\n\n"
            "【出力形式】\n"
            "良い点・改善点をそれぞれ挙げ、最後にプロンプトへの改善提案があれば添えてください。\n"
            "改善提案がある場合は [PROMPT_UPDATE] フォーマットで含めてください。\n\n"
            "参考 - 現在のプロンプト:\n"
            "Positive: {positive_prompt}\n"
            "Negative: {negative_prompt}"
        ),
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "library-assist",
        "name": "ライブラリ参照・校正",
        "system_prompt": (
            "あなたは画像生成プロンプトの校正アシスタントです。\n"
            "ユーザーの入力をもとに、以下のライブラリ参照プロンプトを参考にして、"
            "Stable Diffusion（Illustrious チェックポイント）向けの高品質なプロンプトを組み立ててください。\n\n"
            "【ライブラリ参照プロンプト（類似上位5件）】\n"
            "{library_context}\n\n"
            "現在のプロンプト:\n"
            "Positive: {positive_prompt}\n\n"
            "【指示】\n"
            "- ユーザーの入力内容を最優先にしてください。\n"
            "- 参照プロンプトの「プロンプト:」欄のタグ・語彙・スタイルを参考に、適切なプロンプトを組み立ててください。\n"
            "- 「説明:」欄はプロンプトの内容を理解するための補足情報です。出力プロンプトに自然言語の説明文を含めないでください。\n"
            "- Positive プロンプトは意味のまとまりごとに改行を入れ、読みやすく整形してください。\n"
            "- Negative プロンプトは空のままにしてください。\n"
            "- 結果は必ず [PROMPT_UPDATE] フォーマットで出力してください。\n\n"
            + _PROMPT_UPDATE_BLOCK
        ),
        "created_at": 0,
        "updated_at": 0,
    },
    {
        "id": "chat",
        "name": "自由会話",
        "system_prompt": (
            "あなたは画像生成に詳しいアシスタントです。\n"
            "ユーザーの質問に自由に答えてください。\n\n"
            "参考 - 現在のプロンプト:\n"
            "Positive: {positive_prompt}\n"
            "Negative: {negative_prompt}"
        ),
        "created_at": 0,
        "updated_at": 0,
    },
]


def _ensure_file() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if PROMPTS_PATH.exists():
        return
    now = time.time()
    prompts = [{**p, "created_at": now, "updated_at": now} for p in DEFAULT_PROMPTS]
    _write(prompts)


def _write(prompts: list[dict[str, Any]], deleted_defaults: list[str] | None = None) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    data: dict[str, Any] = {"prompts": prompts}
    if deleted_defaults is not None:
        data["deleted_defaults"] = deleted_defaults
    PROMPTS_PATH.write_text(
        json.dumps(data, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _slug(value: str) -> str:
    return make_slug(value, "chat-prompt")


def list_prompts() -> list[dict[str, Any]]:
    _ensure_file()
    try:
        data = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))
        prompts = [p for p in data.get("prompts", []) if isinstance(p, dict)]
        deleted_defaults: set[str] = set(data.get("deleted_defaults", []))
    except Exception:
        prompts = []
        deleted_defaults = set()

    if not prompts:
        now = time.time()
        prompts = [{**p, "created_at": now, "updated_at": now} for p in DEFAULT_PROMPTS]
        _write(prompts, [])
        return prompts

    # 明示的に削除されていないデフォルトプリセットを補完・更新する
    existing = {str(p.get("id")): p for p in prompts}
    changed = False
    now = time.time()
    for default in DEFAULT_PROMPTS:
        did = default["id"]
        if did in deleted_defaults:
            continue
        if did not in existing:
            prompts.append({**default, "created_at": now, "updated_at": now})
            changed = True
        elif (
            existing[did].get("system_prompt") != default["system_prompt"]
            and not existing[did].get("user_modified")
        ):
            # コード側でデフォルト内容が変わった場合のみ上書き（ユーザー編集済みは除外）
            for p in prompts:
                if p.get("id") == did:
                    p["system_prompt"] = default["system_prompt"]
                    p["updated_at"] = now
                    break
            changed = True
    if changed:
        _write(prompts, list(deleted_defaults))

    return prompts


def get_prompt(prompt_id: str) -> dict[str, Any] | None:
    return next((p for p in list_prompts() if p.get("id") == prompt_id), None)


def save_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    prompts = list_prompts()
    now = time.time()
    explicit_id = str(payload.get("id") or "").strip()
    prompt_id = explicit_id or _slug(str(payload.get("name") or "chat-prompt"))
    existing_ids = {str(p.get("id")) for p in prompts}
    # 新規作成（ID 未指定）でスラッグが既存と衝突した場合はサフィックスで一意化する
    if not explicit_id and prompt_id in existing_ids:
        base = prompt_id
        i = 2
        while prompt_id in existing_ids:
            prompt_id = f"{base}-{i}"
            i += 1

    is_default = any(d["id"] == prompt_id for d in DEFAULT_PROMPTS)
    item: dict[str, Any] = {
        "id": prompt_id,
        "name": str(payload.get("name") or prompt_id).strip() or prompt_id,
        "system_prompt": str(payload.get("system_prompt") or "").strip(),
        "created_at": now,
        "updated_at": now,
    }
    if is_default:
        default_sys = next(d["system_prompt"] for d in DEFAULT_PROMPTS if d["id"] == prompt_id)
        item["user_modified"] = item["system_prompt"] != default_sys
    if not item["system_prompt"]:
        raise ValueError("system_prompt は必須です")

    replaced = False
    for idx, p in enumerate(prompts):
        if p.get("id") == prompt_id:
            item["created_at"] = p.get("created_at") or now
            prompts[idx] = item
            replaced = True
            break
    if not replaced:
        prompts.append(item)
    _write(prompts)
    return item


def delete_prompt(prompt_id: str) -> None:
    try:
        data = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))
        deleted_defaults: list[str] = data.get("deleted_defaults", [])
    except Exception:
        deleted_defaults = []

    prompts = [p for p in list_prompts() if p.get("id") != prompt_id]

    if any(d["id"] == prompt_id for d in DEFAULT_PROMPTS):
        if prompt_id not in deleted_defaults:
            deleted_defaults = [*deleted_defaults, prompt_id]

    if not prompts:
        now = time.time()
        prompts = [{**p, "created_at": now, "updated_at": now} for p in DEFAULT_PROMPTS]
        deleted_defaults = []

    _write(prompts, deleted_defaults)


