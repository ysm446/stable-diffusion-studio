"""シーケンス API。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from server.library import sequence_export, sequences
from server.streaming import make_sse_response

router = APIRouter(prefix="/api/sequences")


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except sequences.SequenceNotFound as e:
        raise HTTPException(status_code=404, detail=str(e))
    except (sequences.SequenceError, ValueError) as e:
        raise HTTPException(status_code=400, detail=str(e))


class SequenceCreate(BaseModel):
    name: str = ""


class SequenceUpdate(BaseModel):
    name: str | None = None
    nodes: list[dict[str, Any]] | None = None
    edges: list[dict[str, Any]] | None = None
    bgm: dict[str, Any] | None = None


@router.get("")
def list_sequences() -> dict[str, Any]:
    return {"sequences": sequences.list_sequences()}


@router.post("")
def create_sequence(body: SequenceCreate) -> dict[str, Any]:
    return _wrap(sequences.create_sequence, body.name)


@router.get("/{seq_id}")
def get_sequence(seq_id: str) -> dict[str, Any]:
    seq = _wrap(sequences.get_sequence, seq_id)
    seq["nodes"] = _wrap(sequences.resolve_nodes, seq)
    return seq


@router.patch("/{seq_id}")
def update_sequence(seq_id: str, body: SequenceUpdate) -> dict[str, Any]:
    fields = {k: v for k, v in body.model_dump(exclude_unset=True).items()}
    seq = _wrap(sequences.update_sequence, seq_id, fields)
    seq["nodes"] = _wrap(sequences.resolve_nodes, seq)
    return seq


@router.delete("/{seq_id}")
def delete_sequence(seq_id: str) -> dict[str, bool]:
    _wrap(sequences.delete_sequence, seq_id)
    return {"ok": True}


@router.post("/{seq_id}/export")
async def export_sequence(seq_id: str):
    def worker(send) -> None:
        try:
            result = sequence_export.export_sequence(
                seq_id, lambda text: send({"type": "status", "content": text})
            )
            mode = "無劣化 concat" if result["mode"] == "copy" else "再エンコード"
            send({
                "type": "export",
                "path": result["path"],
                "mode": result["mode"],
                "status": f"書き出し完了（{mode} / {result['clips']}クリップ）: {result['path']}",
            })
        except Exception as e:
            send({"type": "error", "content": f"書き出しエラー: {e}"})
        finally:
            send({"type": "done"})

    return make_sse_response(worker)


@router.get("/{seq_id}/export/file")
def get_exported_file(seq_id: str, path: str):
    """書き出し済みファイルの配信（エクスポート先ディレクトリ内のみ許可）。"""
    from pathlib import Path

    target = Path(path).resolve()
    export_dir = sequence_export._export_dir().resolve()
    if export_dir != target.parent or not target.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    return FileResponse(str(target))
