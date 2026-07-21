"""スニペット API。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from server.library import snippets

router = APIRouter(prefix="/api/snippets")


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except snippets.SnippetError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("")
def list_snippets() -> dict[str, Any]:
    return {"snippets": snippets.list_snippets()}


@router.get("/files")
def list_files() -> dict[str, Any]:
    return {"files": snippets.list_files()}


@router.get("/root")
def get_root() -> dict[str, Any]:
    return snippets.root_info()


@router.post("/reveal")
def reveal_folder() -> dict[str, bool]:
    """スニペットフォルダをエクスプローラーで開く（無ければ作成）。"""
    import os
    import subprocess

    d = snippets.snippets_dir()
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"フォルダを作成できません: {e}")
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="Windows のみ対応しています")
    subprocess.Popen(["explorer", str(d)])
    return {"ok": True}


class RootUpdate(BaseModel):
    path: str = ""


@router.post("/root")
def set_root(body: RootUpdate) -> dict[str, Any]:
    return _wrap(snippets.set_root, body.path)


@router.get("/file")
def read_file(path: str) -> dict[str, str]:
    return {"path": path, "content": _wrap(snippets.read_file, path)}


class FileSave(BaseModel):
    path: str
    content: str


@router.put("/file")
def save_file(body: FileSave) -> dict[str, bool]:
    _wrap(snippets.save_file, body.path, body.content)
    return {"ok": True}


class FileCreate(BaseModel):
    path: str


@router.post("/file")
def create_file(body: FileCreate) -> dict[str, str]:
    return {"path": _wrap(snippets.create_file, body.path)}


@router.delete("/file")
def delete_file(path: str) -> dict[str, bool]:
    _wrap(snippets.delete_file, path)
    return {"ok": True}
