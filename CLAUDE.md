# CLAUDE.md

このファイルは、Stable Diffusion Studio で作業するエージェント向けのプロジェクトルールです。
（AGENTS.md と同じ方針。Claude Code 向けに現行構成へ合わせて記述）

## プロジェクト概要

ライブラリを中心に据えた画像・動画生成デスクトップアプリ。旧 Image Assistant の派生で、
Forge / ComfyUI / llama-server 連携などの部品を `legacy/` から移植して再構築している。

- **フォルダが正のデータ**：画像 1 件 = 1 フォルダ（`image.png` + `meta.json` + `videos/`）。
  SQLite（`data/library/.studio/index.sqlite3`）は常に再構築可能なキャッシュ。
- スタック：Electron（`frontend/` の vanilla JS、ビルド不要）+ FastAPI（`server/`）+ Forge/ComfyUI/llama-server。
- 設計の正本は [docs/library-first-redesign.md](docs/library-first-redesign.md)。

## 基本方針

- このプロジェクト固有の説明、判断基準、運用ルールは日本語で書く。
- コード、コマンド、API 名、ファイルパス、識別子は既存の表記を優先し、無理に翻訳しない。
- 既存の実装方針を確認してから変更する。
- ユーザーの未コミット変更を勝手に戻さない。
- 変更は必要な範囲に留め、無関係な整形やリファクタリングを混ぜない。
- `legacy/` は移植元の参照専用。動作コードとして使わない・import しない。

## 作業開始時の確認

1. `docs/plan/goals.md` — プロジェクトの目的、完成形、重視する価値。
2. `docs/plan/plan.md` — 実装方針、優先順位、今後の予定。
3. `docs/plan/progress.md` — 現在の進捗、完了済み作業、未完了作業、注意点。
4. [docs/library-first-redesign.md](docs/library-first-redesign.md) — 設計とマイルストーン、進捗。
5. 関連する `server/` / `frontend/` の既存実装。
6. 今回の依頼が現在の計画や進捗のどこに関係するかを把握してから作業する。方針と矛盾しそうな場合は実装前に確認する。

## アーキテクチャの要点

- ライブラリコアは `server/library/`（`items` / `folders` / `index_db` / `meta` / `paths` /
  `embeddings` / `sequences` / `sequence_export` / `video_import` / `png_meta` / `thumbs`）。
- 生成・外部プロセス連携は `server/generation/`。API は `server/routes/`（library / generation /
  sequences / llm / status）で、`server/main.py` に集約。
- 書き込み順序は「ファイル → meta.json → インデックス」。途中失敗してもフォルダスキャンで復旧できる。
- 長時間処理（生成・書き出し・embedding 更新）は SSE。`server/streaming.py` の `make_sse_response` を使う。
- フロントは `frontend/app.js`（ライブラリ）と `frontend/sequence.js`（シーケンス）。
  テキスト入力は Electron で `window.prompt()` が使えないため `frontend/dialog.js` の
  `showInputDialog` を使う。

## コマンド実行ルール

- 環境はサーバー既定ポート **8785**（旧 Image Assistant は 8765）。
- ファイル検索は `rg` / `rg --files` を優先する。
- サーバー起動: `python -m server.main --port <port>`。テスト時は別ポート＋一時ライブラリを使う:
  - 環境変数 `STUDIO_LIBRARY_ROOT` で一時フォルダを指定すると、実ライブラリを汚さずに検証できる。
- 検証後はテスト用サーバーを停止し、一時フォルダを削除する。

## 検証

- フロント JS を変更したら `node --check frontend/<file>.js` で構文確認する。
- バックエンドを変更したら該当するスモークテストを実行する（`STUDIO_LIBRARY_ROOT` を一時フォルダに）:
  - `python tests/test_library_core.py`（フォルダ/アイテム/動画 CRUD・検索・取り込み）
  - `python tests/test_generation_service.py`（生成→保存、バックエンドはモック）
  - `python tests/test_sequences.py`（ノードグラフ・順路・ffmpeg 連結。ffmpeg 必須）
  - `python tests/test_embeddings.py`（ベクトル/ハイブリッド検索、embedding はフェイク）
  - `python tests/test_library_root.py`（ライブラリルート切替）
- UI の見た目は、テスト用サーバーを起動しヘッドレスブラウザのスクリーンショットで確認するとよい。
- GPU が必要な実生成（Forge/ComfyUI/LLM の実行）はこの環境では検証できないことがある。
  その場合はモックで検証し、実機確認が必要な旨を作業報告に書く。

## 変更を反映する際の注意

- **サーバー側（`server/`, `electron/`）の変更**はアプリ再起動（`start.bat`）が必要。
- **フロント（`frontend/`）だけの変更**は再読み込み（Ctrl+R）で反映される。
- 作業報告には「Ctrl+R で足りるか / 再起動が必要か」を明記する。

## ドキュメント

- 設計・マイルストーンは [docs/library-first-redesign.md](docs/library-first-redesign.md) に集約する。
- 進捗管理は `docs/plan/` を入口として保ち、作業が一区切りしたら更新する:
  - `docs/plan/progress.md` — 完了した作業、確認したこと、残っている注意点を追記する。
  - `docs/plan/plan.md` — 実装方針、優先順位、今後の予定が変わったら反映する。
  - `docs/plan/goals.md` — プロジェクトの目的や価値基準が変わったときのみ更新する。
- `docs/**/*.md` を新規作成または内容更新するときは、本文の先頭付近に作成日時と更新日時を
  `YYYY-MM-DD HH:MM` 形式で書く。既存ドキュメントの更新時は更新日時を現在の作業日時にする。
  - 例: `作成日時: 2026-05-19 22:10` / `更新日時: 2026-05-19 22:10`
- ユーザー向けの機能説明は [README.md](README.md) を更新する。
