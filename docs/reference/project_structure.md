# プロジェクト構成メモ

作成日時: 2026-05-19 23:40
更新日時: 2026-05-19 23:40

このメモは、Image Assistant のルート直下に置くファイルと、サブディレクトリへ分けるファイルの判断をまとめるための設計メモです。

## 現在の判断

ルート直下には、アプリ起動に直接関係する Python エントリーポイントと、そこから import される主要モジュールを置く。

- `server.py`: FastAPI サーバーの入口。
- `start.bat`: Windows での起動入口。
- `*_client.py`: Forge、ComfyUI、LLM、embedding など外部バックエンドとの接続。
- `*_process.py`: 管理対象プロセスの起動・停止。
- `*_store.py` / `settings_manager.py`: 設定やプロンプト保存。
- `image_library.py`: 画像ライブラリの SQLite / embedding / 検索まわり。
- `prompt_parser.py` / `helpers.py` / `streaming.py`: 共有ユーティリティ。

一方で、実行時に直接 import されない開発・調査用スクリプトは `tools/` に置く。

## 整理済み

- 古い Gradio / A1111 想定の仕様書 `spec_sd_qwen_app.md` は削除した。
- `AGENTS.md` と役割が重なる古い `CLAUDE.md` は削除した。
- ルート直下の空の `package-lock.json` は削除した。Electron の npm 管理は `electron/package.json` と `electron/package-lock.json` を使う。
- 単発確認用 `_check_png_meta.py` は削除した。
- Forge API 調査用スクリプトは `tools/discover_forge_api.py` に移動した。

## 今後の候補

ルート直下の Python ファイルをさらに減らす場合は、単純な移動ではなく、import パスを含むリファクタとして扱う。

候補:

- `clients/`: `a1111_client.py`、`comfyui_client.py`、`llm_client.py`、`embedding_client.py`
- `processes/`: `managed_process.py`、`sd_process.py`、`comfy_process.py`
- `stores/`: `prompt_store_base.py`、`chat_prompt_store.py`、`caption_prompt_store.py`、`settings_manager.py`
- `core/` または `services/`: `image_library.py`、`helpers.py`、`streaming.py`

この整理は影響範囲が広いため、今回のクリーンアップでは実施しない。実施する場合は、ルートの `server.py` と `routes/` からの import、起動スクリプト、README のファイル構成をまとめて更新する。
