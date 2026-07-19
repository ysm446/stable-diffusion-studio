from __future__ import annotations

import asyncio
import functools
import json
import os
import subprocess
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

import a1111_client
import comfy_process
import comfyui_client
import embedding_client
import llm_client
import sd_process
import settings_manager
from app_state import _state
from helpers import get_snippets_dir, strip_jsonc_comments

try:
    import psutil as _psutil
    _HAS_PSUTIL = True
except ImportError:
    _HAS_PSUTIL = False

try:
    import pynvml as _pynvml
    _pynvml.nvmlInit()
    _NVML_HANDLE = _pynvml.nvmlDeviceGetHandleByIndex(0)
    _HAS_NVML = True
except Exception as _nvml_err:
    _HAS_NVML = False
    print(f"[system_stats] pynvml unavailable: {_nvml_err}")

router = APIRouter()


# ---------------------------------------------------------------------------
# Snippet helpers
# ---------------------------------------------------------------------------

def _resolve_snippet_path(rel_path: str) -> Path:
    if not rel_path:
        raise HTTPException(400, "Snippet path is required")
    base = get_snippets_dir()
    candidate = (base / rel_path).resolve()
    try:
        candidate.relative_to(base.resolve())
    except ValueError as exc:
        raise HTTPException(400, "Invalid snippet path") from exc
    if candidate.suffix != ".code-snippets":
        raise HTTPException(400, "Invalid snippet file extension")
    return candidate


def _load_snippet_file(path: Path) -> dict[str, dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8-sig")
        data = json.loads(strip_jsonc_comments(raw))
    except FileNotFoundError as exc:
        raise HTTPException(404, "Snippet file not found") from exc
    except Exception as exc:
        raise HTTPException(400, f"Failed to parse snippet file: {path.name}") from exc
    if not isinstance(data, dict):
        raise HTTPException(400, "Invalid snippet file structure")
    return data


def _load_snippets() -> list[dict[str, str]]:
    snip_dir = get_snippets_dir()
    if not snip_dir.exists():
        return []
    snippets: list[dict[str, str]] = []
    for path in sorted(snip_dir.rglob("*.code-snippets")):
        try:
            raw = path.read_text(encoding="utf-8-sig")
            data = json.loads(strip_jsonc_comments(raw))
        except Exception:
            continue
        for name, item in data.items():
            if not isinstance(item, dict):
                continue
            prefix = str(item.get("prefix", "")).strip()
            body = item.get("body", [])
            description = str(item.get("description", "")).strip()
            body_lines = [body] if isinstance(body, str) else [str(l) for l in body] if isinstance(body, list) else []
            text = "\n".join(body_lines).strip()
            if not prefix or not text:
                continue
            snippets.append({
                "name": str(name),
                "prefix": prefix,
                "body": text,
                "description": description,
                "source": str(path.relative_to(snip_dir)).replace("\\", "/"),
            })
    return snippets


def _serialize_snippet_file(snippets: list[dict[str, Any]]) -> str:
    payload: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(snippets):
        name = str(item.get("name", "")).strip() or f"snippet_{index + 1}"
        prefix = str(item.get("prefix", "")).strip()
        description = str(item.get("description", "")).strip()
        body = item.get("body", [])
        body_lines = [body] if isinstance(body, str) else [str(l) for l in body] if isinstance(body, list) else []
        if not prefix or not body_lines:
            continue
        payload[name] = {"prefix": prefix, "body": body_lines, "description": description}
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


# ---------------------------------------------------------------------------
# Snippet routes
# ---------------------------------------------------------------------------

def _snippets_root_info() -> dict:
    configured = (settings_manager.load().get("snippets_root") or "").strip()
    root = get_snippets_dir()
    return {
        "root": str(root),
        "configured": configured,
        "is_default": not configured,
        "exists": root.exists(),
    }


@router.get("/api/snippets/root")
def get_snippets_root():
    return _snippets_root_info()


@router.post("/api/snippets/root")
async def set_snippets_root(request: Request):
    body = await request.json()
    raw = (body.get("path") or "").strip().strip('"')
    settings = settings_manager.load()
    settings["snippets_root"] = raw
    settings_manager.save(settings)
    root = get_snippets_dir()
    if raw and not root.exists():
        raise HTTPException(400, f"フォルダが存在しません: {root}")
    return {"ok": True, **_snippets_root_info()}


@router.get("/api/snippets")
def get_snippets():
    return {"snippets": _load_snippets()}


@router.get("/api/snippet_files")
def get_snippet_files():
    snip_dir = get_snippets_dir()
    files = []
    if snip_dir.exists():
        for path in sorted(snip_dir.rglob("*.code-snippets")):
            rel = str(path.relative_to(snip_dir)).replace("\\", "/")
            try:
                count = len(_load_snippet_file(path))
            except HTTPException:
                count = 0
            files.append({
                "path": rel,
                "name": path.name,
                "count": count,
            })
    return {"files": files}


@router.get("/api/snippet_file")
def get_snippet_file(path: str = Query(...)):
    snippet_path = _resolve_snippet_path(path)
    data = _load_snippet_file(snippet_path)
    snippets = []
    for name, item in data.items():
        if not isinstance(item, dict):
            continue
        body = item.get("body", [])
        body_lines = [body] if isinstance(body, str) else [str(l) for l in body] if isinstance(body, list) else []
        snippets.append({
            "name": str(name),
            "prefix": str(item.get("prefix", "")),
            "body": "\n".join(body_lines),
            "description": str(item.get("description", "")),
        })
    return {
        "path": path,
        "name": snippet_path.name,
        "snippets": snippets,
    }


@router.post("/api/snippet_file")
async def save_snippet_file(request: Request):
    body = await request.json()
    rel_path = str(body.get("path", "")).strip()
    snippet_path = _resolve_snippet_path(rel_path)
    snippets = body.get("snippets", [])
    if not isinstance(snippets, list):
        raise HTTPException(400, "Invalid snippets payload")
    snippet_path.parent.mkdir(parents=True, exist_ok=True)
    normalized = []
    for item in snippets:
        if not isinstance(item, dict):
            continue
        normalized.append({
            "name": str(item.get("name", "")).strip(),
            "prefix": str(item.get("prefix", "")).strip(),
            "body": str(item.get("body", "")).splitlines() or [str(item.get("body", "")).strip()],
            "description": str(item.get("description", "")).strip(),
        })
    snippet_path.write_text(_serialize_snippet_file(normalized), encoding="utf-8")
    return {"ok": True}


@router.post("/api/snippet_file/create")
async def create_snippet_file(request: Request):
    body = await request.json()
    file_name = str(body.get("file_name", "")).strip()
    if not file_name:
        raise HTTPException(400, "File name is required")
    if not file_name.endswith(".code-snippets"):
        file_name += ".code-snippets"
    rel_path = file_name
    snippet_path = _resolve_snippet_path(rel_path)
    if snippet_path.exists():
        raise HTTPException(400, "Snippet file already exists")
    snippet_path.parent.mkdir(parents=True, exist_ok=True)
    snippet_path.write_text("{}\n", encoding="utf-8")
    return {"ok": True, "path": rel_path}


@router.delete("/api/snippet_file")
def delete_snippet_file(path: str = Query(...)):
    snippet_path = _resolve_snippet_path(path)
    if not snippet_path.exists():
        raise HTTPException(404, "Snippet file not found")
    snippet_path.unlink()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

def _apply_process_settings(settings: dict) -> None:
    sd_process.configure(settings)
    if sd_process.is_enabled():
        a1111_client.set_preferred_forge_url(sd_process.get_url())
        sd_process.start_background()
    else:
        a1111_client.set_preferred_forge_url(None)
    comfy_process.configure(settings)
    if comfy_process.is_enabled():
        comfyui_client.COMFYUI_URL = comfy_process.get_url()
        comfy_process.start_background()
    else:
        comfyui_client.COMFYUI_URL = settings.get("comfyui_url", "http://127.0.0.1:8188")


@router.get("/api/settings")
def get_settings():
    return settings_manager.load()


@router.post("/api/settings")
async def save_settings(request: Request):
    body = await request.json()
    # UI が送らないキー（library_root / snippets_root / managed_* 等）を消さないよう既存設定へマージする
    settings = settings_manager.load()
    settings.update(body)
    settings_manager.save(settings)
    _apply_process_settings(settings_manager.load())
    return {"ok": True}


# ---------------------------------------------------------------------------
# Model management
# ---------------------------------------------------------------------------

@router.get("/api/model_presets")
def get_model_presets():
    presets = llm_client.refresh_model_presets()
    return {"presets": list(presets.keys())}


@router.post("/api/load_model")
async def load_model(request: Request):
    body = await request.json()
    model_label = body.get("model_label", "")
    model_id = llm_client.MODEL_PRESETS.get(model_label, model_label)
    loop = asyncio.get_running_loop()
    try:
        msg = await loop.run_in_executor(None, functools.partial(llm_client.load_model, model_id))
        return {"ok": True, "message": msg}
    except RuntimeError as e:
        return {"ok": False, "message": str(e)}


@router.post("/api/unload_qwen")
def unload_qwen():
    return {"ok": True, "message": llm_client.unload_model()}


@router.get("/api/llm_status")
def llm_status():
    return llm_client.get_status()


@router.get("/api/debug/last_prompt")
def debug_last_prompt():
    import json as _json

    def _sanitize(messages):
        result = []
        for m in messages:
            role = m.get("role", "")
            content = m.get("content", "")
            if isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "image_url":
                            parts.append("[image]")
                        elif block.get("type") == "text":
                            parts.append(block.get("text", ""))
                    else:
                        parts.append(str(block))
                content = "\n".join(parts)
            result.append({"role": role, "content": str(content)})
        return result

    messages = llm_client.get_last_messages()
    return {"messages": _sanitize(messages), "count": len(messages)}


# ---------------------------------------------------------------------------
# VRAM / process status
# ---------------------------------------------------------------------------

@router.post("/api/free_comfyui")
def free_comfyui():
    return {"ok": True, "message": comfyui_client.free_vram()}


@router.post("/api/free_embedding")
def free_embedding():
    return {"ok": True, "message": embedding_client.stop()}


@router.post("/api/free_forge")
def free_forge():
    if sd_process.is_enabled():
        msg = sd_process.stop()
        a1111_client.reset_connection()
        return {"ok": True, "message": f"WebUI Forge を停止して VRAM を解放しました。{msg}"}
    return {"ok": True, "message": a1111_client.free_vram()}


@router.get("/api/forge_status")
def get_forge_status():
    return sd_process.status()


@router.get("/api/comfyui_status")
def get_comfyui_status():
    return comfy_process.status()


@router.get("/api/system_stats")
def get_system_stats():
    result: dict[str, float | None] = {
        "gpu_util": None,
        "vram_used": None,
        "vram_total": None,
        "cpu_util": None,
        "ram_used": None,
        "ram_total": None,
    }
    if _HAS_PSUTIL:
        result["cpu_util"] = _psutil.cpu_percent(interval=None)
        vm = _psutil.virtual_memory()
        result["ram_used"] = round(vm.used / 1024 ** 3, 1)
        result["ram_total"] = round(vm.total / 1024 ** 3, 1)
    if _HAS_NVML:
        try:
            util = _pynvml.nvmlDeviceGetUtilizationRates(_NVML_HANDLE)
            mem = _pynvml.nvmlDeviceGetMemoryInfo(_NVML_HANDLE)
            result["gpu_util"] = float(util.gpu)
            result["vram_used"] = round(mem.used / 1024 ** 3, 1)
            result["vram_total"] = round(mem.total / 1024 ** 3, 1)
        except Exception:
            pass
    return result


def _gpu_processes() -> list[dict[str, Any]]:
    if not _HAS_NVML:
        return []
    try:
        procs = _pynvml.nvmlDeviceGetComputeRunningProcesses(_NVML_HANDLE)
    except Exception:
        try:
            procs = _pynvml.nvmlDeviceGetGraphicsRunningProcesses(_NVML_HANDLE)
        except Exception:
            return []

    rows: list[dict[str, Any]] = []
    for proc in procs:
        pid = int(proc.pid)
        used_bytes = proc.usedGpuMemory if proc.usedGpuMemory is not None else 0
        used_mib = round(float(used_bytes) / 1024 ** 2, 1)
        name = ""
        path = ""
        if _HAS_PSUTIL:
            try:
                ps = _psutil.Process(pid)
                name = ps.name()
                path = ps.exe()
            except Exception:
                pass
        rows.append({"pid": pid, "name": name, "path": path, "used_mib": used_mib})
    return rows


def _classify_gpu_process(row: dict[str, Any], llm_pid: int | None) -> str:
    if llm_pid and row.get("pid") == llm_pid:
        return "LLM"
    path = str(row.get("path") or row.get("name") or "").lower()
    if "embedding" in path or "8091" in path:
        return "Embedding"
    if "comfy" in path:
        return "ComfyUI"
    if "forge" in path or "stable-diffusion-webui" in path or "webui" in path:
        return "Stable Diffusion"
    if "llama-server" in path:
        return "LLM/llama-server"
    return "Other"


@router.get("/api/vram_debug")
def get_vram_debug():
    llm = llm_client.get_vram_debug()
    llm_pid = llm.get("pid")
    processes = _gpu_processes()
    total_mib = None
    used_mib = None
    if _HAS_NVML:
        try:
            mem = _pynvml.nvmlDeviceGetMemoryInfo(_NVML_HANDLE)
            total_mib = round(float(mem.total) / 1024 ** 2, 1)
            used_mib = round(float(mem.used) / 1024 ** 2, 1)
        except Exception:
            pass
    for row in processes:
        row["group"] = _classify_gpu_process(row, llm_pid)

    grouped: dict[str, float] = {}
    for row in processes:
        group = row["group"]
        grouped[group] = round(grouped.get(group, 0.0) + float(row.get("used_mib") or 0), 1)

    llm_total = 0.0
    for row in processes:
        if llm_pid and row.get("pid") == llm_pid:
            llm_total = float(row.get("used_mib") or 0)
            break

    parts = dict(llm.get("parts_mib") or {})
    known = sum(float(v or 0) for key, v in parts.items() if key != "model_cpu_mapped")
    if llm_total > 0:
        parts["other"] = round(max(0.0, llm_total - known), 1)

    return {
        "ok": True,
        "total_mib": total_mib,
        "used_mib": used_mib,
        "processes": processes,
        "groups_mib": grouped,
        "llm": {
            **llm,
            "total_mib": round(llm_total, 1),
            "parts_mib": parts,
            "estimated": True,
        },
    }


# ---------------------------------------------------------------------------
# Backend / workflow discovery
# ---------------------------------------------------------------------------

@router.get("/api/samplers")
def get_samplers():
    return {"samplers": a1111_client.get_samplers()}


@router.get("/api/workflows")
def get_workflows():
    comfyui_client.reload_workflows()
    return {"workflows": list(comfyui_client.IMAGE_WORKFLOW_PRESETS.keys())}


@router.get("/api/video_workflows")
def get_video_workflows():
    comfyui_client.reload_workflows()
    return {"workflows": list(comfyui_client.VIDEO_WORKFLOW_PRESETS.keys())}


@router.post("/api/open_path")
async def open_path(request: Request):
    body = await request.json()
    target = (body.get("path", "") or "").strip()
    if not target:
        return {"ok": False, "message": "パスが指定されていません"}
    p = Path(target)
    folder = str(p.parent) if p.is_file() else str(p)
    try:
        if not os.path.isdir(folder):
            return {"ok": False, "message": f"フォルダが存在しません: {folder}"}
        if os.name == "nt":
            os.startfile(folder)
        else:
            subprocess.Popen(["xdg-open", folder])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "message": str(e)}


@router.post("/api/open_workflow_folder")
async def open_workflow_folder(request: Request):
    body = await request.json()
    kind = body.get("kind", "image")
    folder = comfyui_client._VIDEO_WORKFLOWS_DIR if kind == "video" else comfyui_client._IMAGE_WORKFLOWS_DIR
    try:
        if not os.path.isdir(folder):
            return {"ok": False, "message": f"フォルダが存在しません: {folder}"}
        if os.name == "nt":
            os.startfile(folder)
        else:
            subprocess.Popen(["xdg-open", folder])
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "message": str(e)}


@router.post("/api/open_backend")
async def open_backend(request: Request):
    body = await request.json()
    backend = body.get("backend", "WebUI Forge")
    if backend == "ComfyUI":
        settings = settings_manager.load()
        url = comfy_process.get_url() if comfy_process.is_enabled() else settings.get("comfyui_url", comfy_process.get_url())
    else:
        url = sd_process.get_url()
    try:
        webbrowser.open(url)
        return {"ok": True, "url": url}
    except Exception as e:
        return {"ok": False, "message": str(e)}


# ---------------------------------------------------------------------------
# Shutdown
# ---------------------------------------------------------------------------

@router.post("/api/shutdown")
def shutdown():
    def _exit():
        time.sleep(0.3)
        llm_client.unload_model()
        embedding_client.stop()
        sd_process.stop()
        comfy_process.stop()
        os._exit(0)
    threading.Thread(target=_exit, daemon=True).start()
    return {"ok": True}
