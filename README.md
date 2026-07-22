# Stable Diffusion Studio

ライブラリを中心に据えた、画像・動画生成のデスクトップアプリです。

生成した画像はすべてライブラリ（フォルダ階層）に保存され、各画像に image-to-video の動画を紐づけて管理できます。動画はノードグラフでつないで 1 本の動画に書き出せます。旧 Image Assistant の派生プロジェクトで、Forge / ComfyUI / llama-server 連携などの部品を移植しています。

## 主な機能

### ライブラリ（3ペイン UI）
- 左：フォルダツリー（自由な入れ子）。右クリックで作成・リネーム・削除・エクスプローラーで開く
- 中央：サムネイルグリッド。ドラッグで並べ替え（複数選択のまとめて移動も可）、選択画像に動画があれば下部に動画ストリップ
- 右：選択に応じたコンテキストパネル（フォルダ→生成 / 画像→プロパティ / 動画→プロパティ）
- 画像 1 件 = 1 フォルダ（`image.png` + `meta.json` + `videos/`）で、**フォルダが正のデータ**。
  SQLite インデックスは常に再構築可能なキャッシュ（「インデックス再構築」ボタン）
- ライブラリの保存先フォルダは UI から変更でき、ルート名をツリーに表示

### 画像生成
- フォルダを選んで右パネルから生成（WebUI Forge / ComfyUI ワークフロー）
- 結果は PNG メタデータ付きでそのフォルダに保存。プロパティ（Prompt/Seed/Params）は編集可能
- 「✨ この設定で新規生成」で既存画像の設定を生成パネルに読み込み。
  既存画像から生成した結果は元の画像のすぐ左隣に並び、クリックするまでカードに NEW バッジが付く
- ドラッグ & ドロップで既存画像を取り込み、A1111 / ComfyUI の PNG メタデータを自動読み取り

### 動画生成
- 画像を選んで「動画を生成」。ComfyUI の image-to-video ワークフローで生成し、画像に紐づけ保存
- **LLM で動画プロンプト生成**：`models/` の GGUF を選び、追加指示から動画プロンプトを生成。
  生成するセクション（scene / action / camera / style / prompt）を選択可。生成時に自動ロード（前回モデル優先）
- 生成した動画の設定（プロンプト・追加指示・WF・フレーム・seed）を保存・復元、再生成に流用
- 「生成前に LLM をアンロード」チェック（既定オン）で、動画生成の直前に llama-server を停止して VRAM を確保
- 生成済み動画ファイルを動画ストリップにドロップして登録（ComfyUI 埋め込みメタデータから
  プロンプト・seed・フレーム・サイズを抽出）

### 検索・LLM 連携
- FTS5 キーワード / ベクトル / ハイブリッド（RRF）検索。embedding は llama-server + GGUF で差分更新
- 生成パネルからライブラリの類似プロンプトを検索して反映

### スニペット
- VSCode `.code-snippets` 形式で定型プロンプトを管理（`snippets/` フォルダ、UI から変更可）
- Prompt / Negative Prompt / 動画プロンプトの入力中に prefix で自動候補を表示
  （↑↓ で選択、Tab / Enter で挿入、Esc で閉じる）。「🧩 スニペットを挿入」ボタンからも検索して挿入可
- 「スニペット」タブで編集：ファイル一覧 / 項目一覧（全ファイル横断検索）/
  フォーム編集（Name・Prefix・Description・Body）。生 JSON の直接編集にも切り替え可。Ctrl+S で保存

### シーケンス（ノードグラフ）
- ライブラリの動画をノードとして配置し、out→in ポートをドラッグで一本道につなぐ
- パン / ズーム / ドラッグ移動 / エッジ切断 / 順路に沿った連続再生
- ノードを右クリックで「ライブラリの元動画を表示」（該当画像・動画を選択して切り替え）とノード削除
- ffmpeg で 1 本に書き出し（同一パラメータなら無劣化 concat、混在時は再エンコード）
- Ctrl+S で表示中のシーケンスを保存

### その他
- 上部バーに Forge / ComfyUI / LLM / Embedding の起動状態インジケーター
- 下部ステータスバーにシステムリソース（CPU / RAM / GPU / VRAM）
- アプリ終了時に VRAM を解放

## 必要環境

| 項目 | 内容 |
|---|---|
| OS | Windows 想定 |
| Python | 3.10 以上 |
| Node.js | Electron 起動用 |
| GPU | CUDA 対応 GPU 推奨 |
| 画像生成 | SD WebUI Forge または ComfyUI（`runtime/` 配下の管理対象 or 外部起動） |
| 動画生成 | ComfyUI と i2v ワークフロー（`workflows/video/`） |
| シーケンス書き出し / 動画取り込み | ffmpeg / ffprobe（PATH に必要） |
| LLM / ベクトル検索（任意） | `llama-server.exe` と GGUF モデル（`models/` 配下） |

## 起動

[start.bat](start.bat) をダブルクリックすると、`.venv` の作成・依存インストール・
サーバー起動（`python -m server.main --port 8785`）・Electron 起動まで自動で行います。
旧 Image Assistant（ポート 8765）と同時に起動しても競合しません。

手動起動:

```bat
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
python -m server.main --port 8785
```

## 構成

```
server/            FastAPI バックエンド
  library/         ライブラリコア（items / folders / index_db / embeddings /
                   sequences / sequence_export / video_import / png_meta / meta / paths）
  generation/      Forge / ComfyUI / LLM / embedding クライアントとプロセス管理
  routes/          API（library / generation / sequences / llm / status）
  main.py          エントリポイント（ルーティング・起動/終了処理）
frontend/          UI（vanilla JS、ビルド不要。app.js / sequence.js / snippets.js /
                   snippet-autocomplete.js / dialog.js）
electron/          デスクトップシェル
workflows/         ComfyUI ワークフロー（image/ video/）
models/            GGUF モデル（LLM / embedding、任意）
runtime/           管理対象の Forge / ComfyUI / llama-server（任意）
data/library/      ライブラリ本体（設定 library_root で変更可）
  <folders>/<item-id>/  image.png / thumb.jpg / meta.json / videos/
  .studio/         インデックス DB・シーケンス定義・書き出し先
legacy/            旧 Image Assistant のコード（部品の移植元・未使用）
docs/              設計ドキュメント（docs/library-first-redesign.md が正本）
tests/             スモークテスト（python tests/test_*.py で実行）
```

## API 概要

| プレフィックス | 主な用途 |
|---|---|
| `/api/library` | フォルダ / アイテム / 動画の CRUD、取り込み、検索、並べ替え、embedding、root |
| `/api/generation` | 画像・動画生成（SSE）、ワークフロー一覧、類似プロンプト |
| `/api/llm` | モデル一覧 / ロード / アンロード、動画プロンプト生成（SSE） |
| `/api/sequences` | シーケンス CRUD、連結書き出し（SSE） |
| `/api/snippets` | スニペット一覧 / ファイル CRUD / エントリ取得 / フォルダ設定 |
| `/api/status` | バックエンド起動状態、システムリソース |
| `/api/shutdown` `/api/free_vram` | VRAM 解放 |

## テスト

バックエンドはバックエンド依存をモックしたスモークテストで検証する（ffmpeg 系は実行が必要）。

```bat
python tests/test_library_core.py
python tests/test_generation_service.py
python tests/test_sequences.py
python tests/test_embeddings.py
python tests/test_library_root.py
```

## ドキュメント

- [docs/library-first-redesign.md](docs/library-first-redesign.md) — 設計とマイルストーン（正本）
- [CLAUDE.md](CLAUDE.md) / [AGENTS.md](AGENTS.md) — 作業エージェント向けルール
