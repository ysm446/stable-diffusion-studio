"""
prompt_parser.py
- Qwen3-VL の返答から [PROMPT_UPDATE] タグをパース
- A1111 生成 PNG のメタデータからプロンプト・生成パラメータを読み取る
"""

import json
import re
from PIL import Image


def parse_prompt_update(text: str) -> tuple[str | None, str | None, str]:
    """
    Qwen3-VL の返答から [PROMPT_UPDATE] ブロックを抽出する。

    Returns:
        (positive, negative, display_text)
        - positive / negative: 更新があれば文字列、なければ None
        - display_text: タグブロックを除いたユーザー表示用テキスト
    """
    pattern = re.compile(
        r"\[PROMPT_UPDATE\](.*?)\[/PROMPT_UPDATE\]", re.DOTALL
    )
    match = pattern.search(text)
    if not match:
        return None, None, text

    block = match.group(1).strip()
    display_text = pattern.sub("", text).strip()

    positive = None
    negative = None
    current_field = None
    current_lines: list[str] = []

    def _flush():
        nonlocal positive, negative
        value = "\n".join(current_lines).strip() or None
        if current_field == "positive":
            positive = value
        elif current_field == "negative":
            negative = value

    for line in block.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith("positive:"):
            _flush()
            current_field = "positive"
            current_lines = [stripped[len("positive:"):].strip()]
        elif stripped.lower().startswith("negative:"):
            _flush()
            current_field = "negative"
            current_lines = [stripped[len("negative:"):].strip()]
        elif current_field is not None:
            current_lines.append(stripped)

    _flush()

    return positive, negative, display_text


def read_a1111_metadata(image: Image.Image) -> dict | None:
    """
    A1111 生成画像の PNG メタデータからプロンプト・生成パラメータを読み取る。
    メタデータがない場合は None を返す。
    """
    params_text = image.info.get("parameters", "")
    if not params_text:
        return None

    lines = params_text.strip().splitlines()

    # "Negative prompt:" 行と "Steps:" 行の位置を特定
    neg_idx = next(
        (i for i, l in enumerate(lines) if l.startswith("Negative prompt:")), None
    )
    param_idx = next(
        (i for i, l in enumerate(lines) if l.startswith("Steps:")), None
    )

    # Positive prompt: 先頭〜 Negative / Steps 行の手前
    pos_end = neg_idx if neg_idx is not None else (param_idx if param_idx is not None else len(lines))
    positive = "\n".join(lines[:pos_end]).strip()

    # Negative prompt
    negative = ""
    if neg_idx is not None:
        neg_end = param_idx if param_idx is not None else len(lines)
        neg_lines = lines[neg_idx:neg_end]
        neg_lines[0] = neg_lines[0].removeprefix("Negative prompt:").strip()
        negative = "\n".join(neg_lines).strip()

    result: dict = {"positive": positive, "negative": negative}

    # Steps 行以降をカンマ区切りでパースしてキー値取得
    if param_idx is not None:
        param_line = ", ".join(lines[param_idx:])
        for token in param_line.split(","):
            token = token.strip()
            if ":" in token:
                k, _, v = token.partition(":")
                key = k.strip().lower().replace(" ", "_")
                result[key] = v.strip()

    # Size を width / height に分解（例: "512x768"）
    if "size" in result:
        try:
            w, h = result["size"].lower().split("x")
            result["width"] = int(w)
            result["height"] = int(h)
        except ValueError:
            pass

    # 数値フィールドを適切な型に変換
    for key, typ in [("steps", int), ("cfg_scale", float), ("seed", int)]:
        if key in result:
            try:
                result[key] = typ(result[key])
            except (ValueError, TypeError):
                pass

    return result


_NEG_KEYWORDS = ("negative", "ネガティブ", "neg")


# 動画（i2v）系の latent ノード：フレーム数・サイズを持つ
_VIDEO_LATENT_NODES = (
    "EmptyHunyuanLatentVideo",
    "WanImageToVideo",
    "WanVideoToVideo",
    "EmptyWanLatentVideo",
    "EmptyLTXVLatentVideo",
    "LTXVBaseSampler",
)
_LATENT_NODES = (
    "EmptyLatentImage",
    "EmptySD3LatentImage",
    "EmptyLatentImageSD3",
    *_VIDEO_LATENT_NODES,
)
_FRAMES_KEYS = ("length", "num_frames", "video_frames", "frames")


def parse_comfyui_graph(prompt_json: str) -> dict | None:
    """ComfyUI の API-format prompt JSON からプロンプト・seed・サイズ・フレーム数を抽出する。

    CLIPTextEncode（タイトルに negative 系を含めば negative、他は positive）、
    KSampler / RandomNoise の seed、latent ノードの width/height/length を読む。
    抽出できなければ None。
    """
    try:
        graph = json.loads(prompt_json)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(graph, dict):
        return None

    positive = ""
    negative = ""
    seed = None
    width = height = frames = None

    # 他ノードの negative 入力に接続された CLIPTextEncode を negative とみなす補助
    negative_ids: set[str] = set()
    for node in graph.values():
        if isinstance(node, dict):
            for field, val in (node.get("inputs", {}) or {}).items():
                if field == "negative" and isinstance(val, list) and val:
                    negative_ids.add(str(val[0]))

    for node_id, node in graph.items():
        if not isinstance(node, dict):
            continue
        class_type = node.get("class_type", "")
        inputs = node.get("inputs", {}) or {}
        title = (node.get("_meta", {}).get("title", "") or "").lower()

        if class_type == "CLIPTextEncode":
            text = inputs.get("text", "")
            if not isinstance(text, str):
                continue
            if any(kw in title for kw in _NEG_KEYWORDS) or str(node_id) in negative_ids:
                negative = negative or text
            else:
                positive = positive or text

        if seed is None and class_type in ("KSampler", "KSamplerAdvanced", "RandomNoise"):
            for key in ("seed", "noise_seed"):
                if key in inputs:
                    try:
                        seed = int(inputs[key])
                    except (ValueError, TypeError):
                        seed = None
                    if seed is not None:
                        break

        if class_type in _LATENT_NODES:
            if width is None and isinstance(inputs.get("width"), (int, float)):
                width = int(inputs["width"])
            if height is None and isinstance(inputs.get("height"), (int, float)):
                height = int(inputs["height"])
            if frames is None and class_type in _VIDEO_LATENT_NODES:
                for k in _FRAMES_KEYS:
                    if isinstance(inputs.get(k), (int, float)):
                        frames = int(inputs[k])
                        break

    if not (positive or negative or seed is not None or frames is not None):
        return None

    result: dict = {"positive": positive, "negative": negative}
    if seed is not None:
        result["seed"] = seed
    if width is not None:
        result["width"] = width
    if height is not None:
        result["height"] = height
    if frames is not None:
        result["frames"] = frames
    return result


def read_comfyui_metadata(image: Image.Image) -> dict | None:
    """ComfyUI 生成画像の PNG メタデータ（'prompt' チャンク）からプロンプトを読み取る。"""
    prompt_json = image.info.get("prompt", "")
    if not prompt_json:
        return None
    return parse_comfyui_graph(prompt_json)
