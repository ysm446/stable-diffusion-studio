"""
a1111_client.py
SD WebUI Forge 2 gradio_client ベースクライアント。

Forge 2 は /sdapi/v1/txt2img REST API を廃止し Gradio API のみ提供。
パラメータ構成は tools/discover_forge_api.py で確認済み（152 パラメータ）。
"""

import os

import requests
from PIL import Image
from gradio_client import Client

_FORGE_HOST = "http://127.0.0.1"
_FORGE_PORT_START = 7860
_FORGE_PORT_END = 7880  # 7860〜7879 を探索
_FORGE_PROBE_TIMEOUT = 0.25
_PREFERRED_FORGE_URL: str | None = None

# Forge 2 は /sdapi/v1/samplers を持たないため固定リストを使用
FALLBACK_SAMPLERS = [
    "DPM++ 2M", "DPM++ 2M SDE", "DPM++ SDE",
    "DPM++ 3M SDE", "Euler a", "Euler",
    "DDIM", "PLMS", "UniPC", "LCM",
]

# 接続確認済みの URL（None = 未接続）
FORGE_URL: str | None = None

# Gradio クライアントをキャッシュ（接続は一度だけ確立する）
_client: Client | None = None
_txt2img_defaults: list | None = None
_txt2img_param_indices: dict[str, int] = {}


def _is_forge_gradio(url: str) -> bool:
    """候補 URL が Forge 2 の Gradio API（/txt2img）を持つか判定する。"""
    try:
        client = Client(url, verbose=False)
    except Exception:
        return False

    try:
        config = getattr(client, "config", None)
        if isinstance(config, dict):
            for dep in config.get("dependencies", []) or []:
                if dep.get("api_name") in ("/txt2img", "txt2img"):
                    return True
    except Exception:
        pass

    try:
        api_info = client.view_api(return_format="dict")
        if isinstance(api_info, dict):
            named = api_info.get("named_endpoints", {})
            if isinstance(named, dict) and "/txt2img" in named:
                return True
    except Exception:
        pass

    return False


def _find_forge_url() -> str:
    """ポート 7860〜7879 を順番に試し、最初に応答した URL を返す。"""
    candidates: list[str] = []
    if _PREFERRED_FORGE_URL:
        candidates.append(_PREFERRED_FORGE_URL)
    candidates.extend(
        f"{_FORGE_HOST}:{port}"
        for port in range(_FORGE_PORT_START, _FORGE_PORT_END)
        if f"{_FORGE_HOST}:{port}" not in candidates
    )
    for url in candidates:
        try:
            requests.get(url, timeout=_FORGE_PROBE_TIMEOUT)
            if _is_forge_gradio(url):
                return url
        except Exception:
            continue
    raise RuntimeError(
        f"WebUI Forge に接続できません。"
        f"ポート {_FORGE_PORT_START}〜{_FORGE_PORT_END - 1} を確認しましたが応答がありませんでした。"
    )


def _get_client() -> Client:
    global _client, FORGE_URL
    if _client is None:
        FORGE_URL = _find_forge_url()
        _client = Client(FORGE_URL, verbose=False)
    return _client


def _reset_client() -> None:
    global _client, FORGE_URL, _txt2img_defaults, _txt2img_param_indices
    _client = None
    FORGE_URL = None
    _txt2img_defaults = None
    _txt2img_param_indices = {}


def set_preferred_forge_url(url: str | None) -> None:
    """管理対象 Forge など、優先して接続する URL を設定する。"""
    global _PREFERRED_FORGE_URL
    normalized = (url or "").rstrip("/")
    if normalized != (_PREFERRED_FORGE_URL or ""):
        _PREFERRED_FORGE_URL = normalized or None
        _reset_client()


def reset_connection() -> None:
    """キャッシュ済みの Forge 接続を破棄する。"""
    _reset_client()


# ---------------------------------------------------------------------------
# 公開 API
# ---------------------------------------------------------------------------

def check_connection() -> tuple[bool, str]:
    """Forge 2 が起動しているか確認する。"""
    try:
        _reset_client()
        _get_client()
        return True, f"SD WebUI Forge に接続しました。({FORGE_URL})"
    except Exception as e:
        _reset_client()
        return False, (
            f"SD WebUI Forge に接続できません。"
            f"ポート {_FORGE_PORT_START}〜{_FORGE_PORT_END - 1} で起動しているか確認してください。({e})"
        )


def get_samplers() -> list[str]:
    """利用可能なサンプラー一覧を返す（Forge 2 は固定リスト）。"""
    return FALLBACK_SAMPLERS


def free_vram() -> str:
    """Forge のチェックポイントをアンロードして VRAM を解放する。"""
    try:
        url = FORGE_URL or _find_forge_url()
        resp = requests.post(f"{url}/sdapi/v1/unload-checkpoint", timeout=10)
        resp.raise_for_status()
        _reset_client()
        return f"WebUI Forge のチェックポイントをアンロードしました。({url})"
    except Exception as e:
        return f"WebUI Forge VRAM 解放エラー: {e}"



def generate_image(
    positive: str,
    negative: str,
    steps: int,
    cfg: float,
    sampler: str,
    width: int,
    height: int,
    seed: int,
) -> Image.Image:
    """
    Forge 2 Gradio API (/txt2img) で画像を生成する。

    起動中の Forge から現在の /txt2img パラメータを読み取り、デフォルト値をベースに
    必要な項目だけ上書きする。Forge 拡張の増減で引数順が変わっても壊れにくくする。
    """
    client = _get_client()
    args = _build_txt2img_args(client, positive, negative, steps, cfg, sampler, width, height, seed)

    try:
        result = client.predict(*args, api_name="/txt2img")
    except Exception:
        # クライアントが古い/切断済みの場合に一度だけ再接続して再試行
        _reset_client()
        client = _get_client()
        result = client.predict(*args, api_name="/txt2img")
    return _result_to_image(result)


def _build_txt2img_args(
    client: Client,
    positive: str,
    negative: str,
    steps: int,
    cfg: float,
    sampler: str,
    width: int,
    height: int,
    seed: int,
) -> list:
    defaults, indices = _get_txt2img_schema(client)
    args = list(defaults)

    def set_label(label: str, value) -> None:
        idx = indices.get(label)
        if idx is not None:
            args[idx] = value

    set_label("parameter_47", "")
    set_label("Prompt", positive)
    set_label("Negative prompt", negative)
    set_label("Styles", [])
    set_label("Batch count", 1)
    set_label("Batch size", 1)
    set_label("CFG Scale", float(cfg))
    set_label("Height", int(height))
    set_label("Width", int(width))
    set_label("Hires. fix", False)
    set_label("Script", "None")
    set_label("Sampling steps", int(steps))
    set_label("Sampling method", sampler)
    set_label("Schedule type", "Automatic")
    set_label("Seed", float(seed))
    set_label("Extra", False)

    # X/Y/Z Plot のデフォルトが環境によって "Seed" のことがあるため、明示的に無効化する。
    x_type_indices = [i for i, p in enumerate(_txt2img_param_labels(client)) if p == "X type"]
    if x_type_indices:
        args[x_type_indices[0]] = "Nothing"
    return args


def _get_txt2img_schema(client: Client) -> tuple[list, dict[str, int]]:
    global _txt2img_defaults, _txt2img_param_indices
    if _txt2img_defaults is not None:
        return list(_txt2img_defaults), dict(_txt2img_param_indices)

    info = client.view_api(print_info=False, return_format="dict")
    endpoint = info.get("named_endpoints", {}).get("/txt2img")
    if not endpoint:
        raise RuntimeError("Forge 2 の /txt2img API が見つかりません。")

    params = endpoint.get("parameters", [])
    defaults: list = []
    indices: dict[str, int] = {}
    for i, param in enumerate(params):
        label = str(param.get("label", ""))
        if label and label not in indices:
            indices[label] = i
        default = param.get("parameter_default")
        defaults.append("" if default is None else default)

    _txt2img_defaults = defaults
    _txt2img_param_indices = indices
    return list(defaults), dict(indices)


def _txt2img_param_labels(client: Client) -> list[str]:
    _get_txt2img_schema(client)
    labels = [""] * len(_txt2img_defaults or [])
    for label, idx in _txt2img_param_indices.items():
        if 0 <= idx < len(labels):
            labels[idx] = label
    return labels


# ---------------------------------------------------------------------------
# 内部ヘルパー
# ---------------------------------------------------------------------------

def _result_to_image(result) -> Image.Image:
    """
    gradio_client の predict 戻り値から PIL.Image を取得する。
    Forge 2 は (gallery_data, generation_info, html_info) のタプルを返す。
    """
    if isinstance(result, (list, tuple)):
        gallery = result[0] if result else None
    else:
        gallery = result

    if gallery is None:
        raise RuntimeError("Forge 2 から画像が返されませんでした。")

    def _is_empty(value) -> bool:
        if value is None:
            return True
        if isinstance(value, (list, tuple, dict, str)) and len(value) == 0:
            return True
        return False

    if _is_empty(gallery) or (
        isinstance(gallery, (list, tuple)) and all(_is_empty(item) for item in gallery)
    ):
        raise RuntimeError(
            "Forge から空のギャラリーが返されました。"
            "Forge の Web UI でチェックポイントが選択されているか確認してください。"
        )

    if isinstance(gallery, (list, tuple)) and len(gallery) > 0:
        first = gallery[0]
    else:
        first = gallery

    return _load_image_from_entry(first)


def _load_image_from_entry(entry) -> Image.Image:
    """単一の画像エントリを PIL.Image に変換する。"""

    # gradio_client.utils.FileData オブジェクト（.path 属性）
    if hasattr(entry, "path") and entry.path:
        return Image.open(entry.path).copy()

    # dict 形式: {"image": ..., "name": ..., "path": ...}
    if isinstance(entry, dict):
        for key in ("image", "name", "path", "url"):
            val = entry.get(key)
            if val is not None:
                return _load_image_from_entry(val)

    # ファイルパス文字列
    if isinstance(entry, str) and os.path.isfile(entry):
        return Image.open(entry).copy()

    raise RuntimeError(
        f"画像データの形式を認識できませんでした: type={type(entry)}, value={entry!r}"
    )
