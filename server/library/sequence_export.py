"""シーケンスの連結書き出し（ffmpeg）。

全クリップのコーデック・解像度・fps が一致していれば concat demuxer +
stream copy（無劣化）、混在していれば再エンコード（scale/pad + fps 正規化）に
フォールバックする。どちらになるかは事前に ffprobe で判定して通知する。
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Callable

from server import settings
from server.library import paths, sequences

StatusFn = Callable[[str], None]

_CREATE_NO_WINDOW = 0x08000000  # Windows でコンソールを出さない


class ExportError(Exception):
    pass


def _run(cmd: list[str], timeout: int = 1800) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW,
    )


def probe(path: str) -> dict[str, Any]:
    proc = _run(
        [
            "ffprobe",
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=codec_name,width,height,r_frame_rate,pix_fmt",
            "-of", "json",
            path,
        ],
        timeout=60,
    )
    if proc.returncode != 0:
        raise ExportError(f"ffprobe 失敗: {Path(path).name}: {proc.stderr.strip()[-500:]}")
    streams = json.loads(proc.stdout or "{}").get("streams") or []
    if not streams:
        raise ExportError(f"動画ストリームがありません: {Path(path).name}")
    s = streams[0]
    num, _, den = (s.get("r_frame_rate") or "0/1").partition("/")
    try:
        fps = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        fps = 0.0
    return {
        "codec": s.get("codec_name", ""),
        "width": int(s.get("width") or 0),
        "height": int(s.get("height") or 0),
        "fps": round(fps, 3),
        "pix_fmt": s.get("pix_fmt", ""),
    }


def _export_dir() -> Path:
    raw = str(settings.load().get("sequence_export_dir") or "").strip()
    if raw:
        d = Path(raw).expanduser()
        if not d.is_absolute():
            d = (paths.BASE_DIR / d).resolve()
    else:
        d = paths.studio_dir() / "exports"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_filename(name: str) -> str:
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip() or "sequence"
    return name


def _unique_path(directory: Path, stem: str, ext: str = ".mp4") -> Path:
    candidate = directory / f"{stem}{ext}"
    n = 2
    while candidate.exists():
        candidate = directory / f"{stem}_{n}{ext}"
        n += 1
    return candidate


def export_sequence(seq_id: str, status: StatusFn) -> dict[str, Any]:
    seq = sequences.get_sequence(seq_id)
    clips = sequences.resolve_ordered_clips(seq)
    if not clips:
        raise ExportError("順路につながったクリップがありません（ノードを線でつないでください）")
    missing = [c for c in clips if c["missing"]]
    if missing:
        names = ", ".join(f'{c["item_id"]}/{c["file"]}' for c in missing[:5])
        raise ExportError(f"欠落クリップがあります（{len(missing)}件）: {names}")

    paths_list = [c["path"] for c in clips]
    status(f"クリップを検証中...（{len(paths_list)}件）")
    infos = [probe(p) for p in paths_list]
    uniform = all(
        (i["codec"], i["width"], i["height"], i["fps"], i["pix_fmt"])
        == (infos[0]["codec"], infos[0]["width"], infos[0]["height"], infos[0]["fps"], infos[0]["pix_fmt"])
        for i in infos
    )

    out_path = _unique_path(_export_dir(), _safe_filename(seq.get("name", "sequence")))

    if uniform:
        status("無劣化連結（stream copy）で書き出し中...")
        with tempfile.NamedTemporaryFile(
            "w", suffix=".txt", delete=False, encoding="utf-8"
        ) as f:
            for p in paths_list:
                escaped = p.replace("'", "'\\''")
                f.write(f"file '{escaped}'\n")
            list_path = f.name
        try:
            proc = _run(
                [
                    "ffmpeg", "-y",
                    "-f", "concat", "-safe", "0",
                    "-i", list_path,
                    "-c", "copy",
                    str(out_path),
                ]
            )
        finally:
            Path(list_path).unlink(missing_ok=True)
        if proc.returncode != 0:
            raise ExportError(f"ffmpeg 連結失敗: {proc.stderr.strip()[-800:]}")
        mode = "copy"
    else:
        # 解像度・fps を先頭クリップに合わせて再エンコード
        w, h, fps = infos[0]["width"], infos[0]["height"], infos[0]["fps"] or 16
        status(f"パラメータが混在しているため再エンコードで書き出し中...（{w}x{h} @ {fps}fps）")
        cmd = ["ffmpeg", "-y"]
        for p in paths_list:
            cmd += ["-i", p]
        filters = []
        for i in range(len(paths_list)):
            filters.append(
                f"[{i}:v]scale={w}:{h}:force_original_aspect_ratio=decrease,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,fps={fps},setsar=1[v{i}]"
            )
        concat_in = "".join(f"[v{i}]" for i in range(len(paths_list)))
        filters.append(f"{concat_in}concat=n={len(paths_list)}:v=1:a=0[out]")
        cmd += [
            "-filter_complex", ";".join(filters),
            "-map", "[out]",
            "-c:v", "libx264", "-crf", "18", "-preset", "medium",
            "-pix_fmt", "yuv420p",
            "-an",
            str(out_path),
        ]
        proc = _run(cmd)
        if proc.returncode != 0:
            raise ExportError(f"ffmpeg 再エンコード失敗: {proc.stderr.strip()[-800:]}")
        mode = "reencode"

    # BGM 合成（設定があれば、映像はそのまま・音声をループ BGM で付与）
    bgm_conf = seq.get("bgm")
    if bgm_conf and bgm_conf.get("file"):
        out_path = _mux_bgm(out_path, bgm_conf, status)

    return {"path": str(out_path), "mode": mode, "clips": len(paths_list)}


def _mux_bgm(video_path: Path, bgm_conf: dict[str, Any], status: StatusFn) -> Path:
    """連結済み動画にループ BGM を合成する。映像は stream copy、音声のみ AAC。"""
    from server.library import bgm as bgm_lib

    try:
        bgm_path = bgm_lib.path_for(str(bgm_conf["file"]))
    except FileNotFoundError:
        status("BGM が見つからないため音声なしで書き出しました")
        return video_path

    volume = bgm_conf.get("volume", 0.8)
    try:
        volume = max(0.0, min(1.0, float(volume)))
    except (TypeError, ValueError):
        volume = 0.8

    status("BGM を合成中...")
    with_bgm = video_path.with_name(video_path.stem + "_bgm" + video_path.suffix)
    proc = _run(
        [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-stream_loop", "-1", "-i", str(bgm_path),
            "-filter:a", f"volume={volume}",
            "-map", "0:v", "-map", "1:a",
            "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
            "-shortest",
            str(with_bgm),
        ]
    )
    if proc.returncode != 0:
        status(f"BGM 合成に失敗したため音声なしで書き出しました: {proc.stderr.strip()[-300:]}")
        with_bgm.unlink(missing_ok=True)
        return video_path
    video_path.unlink(missing_ok=True)
    return with_bgm
