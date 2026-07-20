# Stable Diffusion Studio

ライブラリを中心に据えた、画像・動画生成のデスクトップアプリです。

生成した画像はすべてライブラリ（フォルダ階層）に保存され、各画像に image-to-video の動画を紐づけて管理できます。動画はシーケンスとしてつないで 1 本の動画に書き出せます。旧 [Image Assistant] の派生プロジェクトで、Forge / ComfyUI / llama-server 連携などの部品を移植しています。

## 主な機能

- **ライブラリ（3ペイン UI）**: フォルダツリー / サムネイルグリッド / コンテキストパネル。
  画像 1 件 = 1 フォルダ（`image.png` + `meta.json` + `videos/`）で、フォルダが正のデータ。
  SQLite インデックスは常に再構築可能なキャッシュ（「インデックス再構築」ボタン）
- **画像生成**: フォルダを選んで右パネルから生成（WebUI Forge / ComfyUI ワークフロー）。
  結果は PNG メタデータ付きでそのフォルダに保存される
- **動画生成**: 画像を選んで「動画を生成」。ComfyUI の image-to-video ワークフローで生成し、
  画像の子として紐づけ保存（複数可・個別削除可）
- **画像取り込み**: ドラッグ & ドロップで既存画像を取り込み。A1111 / ComfyUI の
  PNG メタデータからプロンプト・Seed を自動読み取り
- **検索**: FTS5 キーワード / ベクトル / ハイブリッド（RRF）。embedding は
  llama-server + GGUF モデルで差分更新（「Embedding 更新」ボタン）
- **類似プロンプト参照**: 生成パネルからライブラリの類似プロンプトを検索して反映
- **シーケンスモード**: ライブラリの動画をつないで連続再生・並べ替えし、
  ffmpeg で 1 本に書き出し（同一パラメータなら無劣化 concat、混在時は再エンコード）

## 必要環境

| 項目 | 内容 |
|---|---|
| OS | Windows 想定 |
| Python | 3.10 以上 |
| Node.js | Electron 起動用 |
| GPU | CUDA 対応 GPU 推奨 |
| 画像生成 | SD WebUI Forge または ComfyUI（`runtime/` 配下の管理対象 or 外部起動） |
| 動画生成 | ComfyUI と i2v ワークフロー（`workflows/video/`） |
| シーケンス書き出し | ffmpeg / ffprobe（PATH に必要） |
| ベクトル検索（任意） | `llama-server.exe` と embedding GGUF モデル（`models/` 配下） |

## 起動

[start.bat](start.bat) をダブルクリックすると、`.venv` の作成・依存インストール・
サーバー起動（`python -m server.main --port 8785`）・Electron 起動まで自動で行います。
旧 Image Assistant（ポート 8765）と同時に起動しても競合しません。

## 構成

```
server/            FastAPI バックエンド
  library/         ライブラリコア（items / folders / index_db / embeddings / sequences / 書き出し）
  generation/      Forge / ComfyUI / embedding クライアントとプロセス管理
  routes/          API（library / generation / sequences）
frontend/          UI（vanilla JS、ビルド不要）
electron/          デスクトップシェル
workflows/         ComfyUI ワークフロー（image/ video/）
data/library/      ライブラリ本体（設定 library_root で変更可）
  .studio/         インデックス DB・シーケンス定義・書き出し先
legacy/            旧 Image Assistant のコード（参照用・未使用）
docs/              設計ドキュメント（docs/library-first-redesign.md が正本）
tests/             スモークテスト（python tests/test_*.py で実行）
```

## ドキュメント

- [docs/library-first-redesign.md](docs/library-first-redesign.md) — 設計とマイルストーン（正本）
