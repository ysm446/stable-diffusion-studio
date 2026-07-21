"""スニペット（VSCode ``.code-snippets`` 形式）の読み書き。

``snippets/`` フォルダ（設定 ``snippets_root`` で変更可）配下の ``.code-snippets``
ファイルを走査し、プロンプト補助として使えるスニペット一覧を返す。ファイル単位の
編集（生テキスト）にも対応する。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from server import settings

BASE_DIR = Path(__file__).resolve().parent.parent.parent
DEFAULT_SNIPPETS_DIR = BASE_DIR / "snippets"


class SnippetError(Exception):
    pass


def strip_jsonc_comments(text: str) -> str:
    """`//` 行コメントを除去する（文字列内は無視）。"""
    lines = []
    for line in text.splitlines():
        in_string = False
        escaped = False
        comment_at = None
        for i, ch in enumerate(line):
            if escaped:
                escaped = False
                continue
            if ch == "\\":
                escaped = True
                continue
            if ch == '"':
                in_string = not in_string
                continue
            if not in_string and ch == "/" and i + 1 < len(line) and line[i + 1] == "/":
                comment_at = i
                break
        lines.append(line[:comment_at] if comment_at is not None else line)
    return "\n".join(lines)


def snippets_dir() -> Path:
    raw = str(settings.load().get("snippets_root") or "").strip()
    if raw:
        d = Path(raw).expanduser()
        if not d.is_absolute():
            d = (BASE_DIR / d).resolve()
        return d
    return DEFAULT_SNIPPETS_DIR


def root_info() -> dict[str, Any]:
    configured = str(settings.load().get("snippets_root") or "").strip()
    d = snippets_dir()
    return {"root": str(d), "configured": configured, "exists": d.exists()}


def set_root(path: str) -> dict[str, Any]:
    settings.update({"snippets_root": (path or "").strip()})
    d = snippets_dir()
    if path.strip() and not d.exists():
        raise SnippetError(f"フォルダが存在しません: {d}")
    return root_info()


def _resolve(rel_path: str) -> Path:
    if not rel_path:
        raise SnippetError("スニペットのパスが指定されていません")
    base = snippets_dir()
    candidate = (base / rel_path).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError:
        raise SnippetError("不正なパスです")
    if candidate.suffix != ".code-snippets":
        raise SnippetError("拡張子は .code-snippets のみ対応です")
    return candidate


def _parse_file(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8-sig")
    data = json.loads(strip_jsonc_comments(raw))
    if not isinstance(data, dict):
        raise SnippetError("スニペットファイルの構造が不正です")
    return data


def list_snippets() -> list[dict[str, str]]:
    """全ファイルのスニペットをフラットな一覧で返す。"""
    d = snippets_dir()
    if not d.exists():
        return []
    result: list[dict[str, str]] = []
    for path in sorted(d.rglob("*.code-snippets")):
        try:
            data = _parse_file(path)
        except (OSError, ValueError, SnippetError):
            continue
        for name, item in data.items():
            if not isinstance(item, dict):
                continue
            prefix = str(item.get("prefix", "")).strip()
            body = item.get("body", [])
            if isinstance(body, str):
                text = body.strip()
            elif isinstance(body, list):
                text = "\n".join(str(b) for b in body).strip()
            else:
                text = ""
            if not text:
                continue
            result.append(
                {
                    "name": str(name),
                    "prefix": prefix,
                    "body": text,
                    "description": str(item.get("description", "")).strip(),
                    "source": str(path.relative_to(d)).replace("\\", "/"),
                }
            )
    return result


def parse_entries(rel_path: str) -> list[dict[str, str]]:
    """1 ファイルをフォーム編集用のエントリ一覧に変換する（body 空も含む）。"""
    path = _resolve(rel_path)
    if not path.is_file():
        raise SnippetError("ファイルが見つかりません")
    try:
        data = _parse_file(path)
    except ValueError as e:
        raise SnippetError(f"JSON として不正です: {e}")
    entries: list[dict[str, str]] = []
    for name, item in data.items():
        if not isinstance(item, dict):
            continue
        body = item.get("body", [])
        if isinstance(body, str):
            text = body
        elif isinstance(body, list):
            text = "\n".join(str(b) for b in body)
        else:
            text = ""
        entries.append(
            {
                "name": str(name),
                "prefix": str(item.get("prefix", "")).strip(),
                "body": text,
                "description": str(item.get("description", "")).strip(),
            }
        )
    return entries


def list_files() -> list[dict[str, Any]]:
    d = snippets_dir()
    files = []
    if d.exists():
        for path in sorted(d.rglob("*.code-snippets")):
            rel = str(path.relative_to(d)).replace("\\", "/")
            try:
                count = len(_parse_file(path))
            except (OSError, ValueError, SnippetError):
                count = 0
            files.append({"path": rel, "name": path.name, "count": count})
    return files


def read_file(rel_path: str) -> str:
    path = _resolve(rel_path)
    if not path.is_file():
        raise SnippetError("ファイルが見つかりません")
    return path.read_text(encoding="utf-8-sig")


def save_file(rel_path: str, content: str) -> None:
    path = _resolve(rel_path)
    # 保存前に JSONC として妥当か検証する
    try:
        json.loads(strip_jsonc_comments(content))
    except ValueError as e:
        raise SnippetError(f"JSON として不正です: {e}")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(path)


def create_file(rel_path: str) -> str:
    if not rel_path.endswith(".code-snippets"):
        rel_path += ".code-snippets"
    path = _resolve(rel_path)
    if path.exists():
        raise SnippetError("同名のファイルが既にあります")
    path.parent.mkdir(parents=True, exist_ok=True)
    template = (
        "{\n"
        '  "サンプル": {\n'
        '    "prefix": "sample",\n'
        '    "body": ["sample prompt"],\n'
        '    "description": "説明"\n'
        "  }\n"
        "}\n"
    )
    path.write_text(template, encoding="utf-8")
    return str(path.relative_to(snippets_dir())).replace("\\", "/")


def delete_file(rel_path: str) -> None:
    path = _resolve(rel_path)
    if not path.is_file():
        raise SnippetError("ファイルが見つかりません")
    path.unlink()
