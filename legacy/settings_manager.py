"""
settings_manager.py
アプリ設定（生成パラメータ・モデル選択）の保存と読み込み。
settings.json にシリアライズする。プロンプトは保存対象外。
"""

import json
import os

SETTINGS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")

# 保存対象外のキー（プロンプト類）
_EXCLUDED_KEYS = {"positive_prompt", "negative_prompt"}

DEFAULT_SETTINGS = {
    "model": "",
    "steps": 28,
    "cfg": 7.0,
    "sampler": "Euler a",
    "width": 512,
    "height": 768,
    "seed": -1,
    "backend": "WebUI Forge",
    "managed_forge_enabled": True,
    "managed_forge_dir": "./runtime/stable-diffusion-webui-forge",
    "managed_forge_host": "127.0.0.1",
    "managed_forge_port": 7861,
    "managed_comfyui_enabled": True,
    "managed_comfyui_dir": "./runtime/ComfyUI",
    "managed_comfyui_host": "127.0.0.1",
    "managed_comfyui_port": 8188,
    "comfyui_workflow": "",
    "comfyui_url": "http://127.0.0.1:8188",
    "comfyui_seed": -1,
    "comfyui_width": 1024,
    "comfyui_height": 1024,
    "save_generated_image": False,
    "image_save_path": "./outputs/images",
    "save_generated_video": False,
    "video_save_path": "./outputs/videos",
    "unload_llm_before_video": False,
    "video_workflow": "",
    "video_sections": ["scene", "action", "camera", "style", "prompt"],
    "video_width": None,
    "video_height": None,
    "video_seed": -1,
    "video_frames": 81,
    "chat_max_tokens": 4096,
    "library_root": "",
    "snippets_root": "",
}


_LEGACY_RUNTIME_PATHS = {
    "managed_forge_dir": {
        "./bin/stable-diffusion-webui-forge",
        "bin/stable-diffusion-webui-forge",
        r".\bin\stable-diffusion-webui-forge",
        r"bin\stable-diffusion-webui-forge",
    },
    "managed_comfyui_dir": {
        "./bin/ComfyUI",
        "bin/ComfyUI",
        r".\bin\ComfyUI",
        r"bin\ComfyUI",
    },
}


def _migrate_runtime_paths(settings: dict) -> None:
    """旧 bin 配下の既定パスだけを runtime 配下へ読み替える。"""
    for key, legacy_paths in _LEGACY_RUNTIME_PATHS.items():
        if settings.get(key) in legacy_paths:
            settings[key] = DEFAULT_SETTINGS[key]


def load() -> dict:
    """settings.json から設定を読み込む。ファイルがなければデフォルトを返す。プロンプトキーは無視する。"""
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
            settings = DEFAULT_SETTINGS.copy()
            settings.update({k: v for k, v in saved.items() if k not in _EXCLUDED_KEYS})
            _migrate_runtime_paths(settings)
            return settings
        except Exception:
            pass
    return DEFAULT_SETTINGS.copy()


def save(settings: dict) -> None:
    """設定を settings.json に書き出す。プロンプトキーは除外する。失敗しても例外を外に出さない。"""
    try:
        filtered = {k: v for k, v in settings.items() if k not in _EXCLUDED_KEYS}
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(filtered, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
