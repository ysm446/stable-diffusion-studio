# Image Assistant

Stable Diffusion / ComfyUI / ローカル LLM をまとめて扱う、画像・動画生成向けのプロンプト支援アプリです。

Electron のデスクトップ UI から、ローカル GGUF モデルとのチャット、画像生成、動画生成、プロンプトスニペット管理を行えます。LLM は `llama-server` の OpenAI 互換 API、画像生成は SD WebUI Forge または ComfyUI、動画生成は ComfyUI ワークフローを使います。

## 主な機能

- **LLM チャット**: 画像や現在の Positive / Negative Prompt を文脈にして、プロンプト案を相談できます。
- **プロンプト自動反映**: AI 応答内の `[PROMPT_UPDATE]` ブロックを解析し、Positive / Negative Prompt に反映します。
- **画像生成**: WebUI Forge または ComfyUI のワークフローで txt2img を実行します。
- **画像読み込み**: 画像をドラッグ & ドロップし、A1111 / ComfyUI PNG メタデータからプロンプトや Seed を読み取ります。
- **動画生成**: ComfyUI の image-to-video ワークフローで、現在の画像から動画を生成します。
- **動画プロンプト生成**: Scene / Action / Camera / Style / Final Prompt の各セクションを LLM で生成します。
- **生成キュー**: 画像生成、動画生成、動画プロンプト生成を順番に処理します。
- **画像ライブラリ**: 画像を `data/library/images/` に保存し、プロンプト、Caption、タグ、embedding を SQLite に登録します。`{library_context}` 変数を使ってライブラリの類似プロンプトを LLM に参照させられます（ベクトル検索 / FTS5 ハイブリッドを切り替え可能）。
- **スニペット管理**: `snippets/` 以下の `.code-snippets` を UI で検索・編集できます。
- **VRAM 解放**: LLM、Forge、ComfyUI のモデルを個別にアンロードできます。
- **設定保存**: モデル、生成パラメータ、保存先、ワークフロー選択などを `settings.json` に保存します。

## 必要環境

| 項目 | 内容 |
|---|---|
| OS | Windows 想定 |
| Python | 3.10 以上推奨 |
| Node.js | Electron 起動用 |
| GPU | CUDA 対応 GPU 推奨 |
| LLM | GGUF モデルと `llama-server.exe` |
| 画像生成 | SD WebUI Forge または ComfyUI |
| 動画生成 | ComfyUI と動画生成ワークフロー |

## セットアップ

### 1. Python 依存関係

`start.bat` はプロジェクト直下の `.venv` を自動作成し、有効化してからサーバーを起動します。初回のみ `requirements.txt` から依存関係をインストールします。

```bat
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
```

`psutil` は管理対象プロセスの終了処理に使います。未導入でも一部処理は動きますが、入れておくのがおすすめです。

### 2. Node.js / Electron

初回起動時に `electron/` で `npm install` が自動実行されます。手動で行う場合は次の通りです。

```bat
cd electron
npm install
```

### 3. llama-server

`llm_client.py` は次の順序で `llama-server.exe` を探します。

1. 環境変数 `LLAMA_SERVER_EXE`
2. `runtime/llama-server/<任意のサブフォルダ>/llama-server.exe`

例:

```text
runtime/
  llama-server/
    llama-bxxxx-bin-win-cuda/
      llama-server.exe
```

必要に応じて環境変数で明示できます。

```bat
set LLAMA_SERVER_EXE=D:\path\to\llama-server.exe
```

### 4. GGUF モデル

`models/` 以下の `.gguf` を再帰的にスキャンします。`mmproj*.gguf` または `*.mmproj*.gguf` が同じフォルダにある場合は Vision 対応モデルとして扱います。

```text
models/
  Qwen-VL-GGUF/
    model-q4_k_m.gguf
    mmproj-model.gguf
  OtherModel/
    other-model.gguf
```

LLM のデフォルト設定は環境変数で変更できます。

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `LLAMA_SERVER_PORT` | `8090` | `llama-server` のポート |
| `LLAMA_N_CTX` | `8192` | コンテキスト長 |
| `LLAMA_MAX_TOKENS` | `4096` | チャット応答の最大トークン |

### 5. Embedding モデル

画像ライブラリの再インデックス化では、Qwen3 Embedding の GGUF を `llama-server` の embedding API として使います。

既定では次のモデルを探します。

```text
models/
  Qwen3-Embedding-4B-GGUF/
    Qwen3-Embedding-4B-Q4_K_M.gguf
```

Embedding サーバーは必要になった時に `http://127.0.0.1:8091` で自動起動します。チャット用 LLM とは別プロセスです。

| 変数 | 既定値 | 内容 |
|---|---:|---|
| `EMBEDDING_SERVER_PORT` | `8091` | embedding 用 `llama-server` のポート |
| `EMBEDDING_MODEL_PATH` | なし | embedding GGUF を明示指定 |
| `EMBEDDING_MODEL` | `Qwen3-Embedding-4B` | `/v1/embeddings` に渡す model 名 |
| `EMBEDDING_UBATCH` | `8192` | `llama-server -ub` の値 |

### 6. Forge / ComfyUI

既定では、アプリが次のローカルディレクトリを管理対象として起動しようとします。

```text
runtime/
  stable-diffusion-webui-forge/
  ComfyUI/
```

外部で起動済みの Forge / ComfyUI に接続することもできます。

| バックエンド | 既定 URL | 補足 |
|---|---|---|
| WebUI Forge | `http://127.0.0.1:7861` | Forge 2 の Gradio `/txt2img` を使用 |
| ComfyUI | `http://127.0.0.1:8188` | REST API を使用 |

管理対象プロセスの既定パスやポートは `settings.json`、または次の環境変数で変更できます。

| 変数 | 内容 |
|---|---|
| `SD_MANAGED_FORGE` | `0` / `false` で Forge 自動起動を無効化 |
| `SD_FORGE_DIR` | Forge のディレクトリ |
| `SD_FORGE_HOST` / `SD_FORGE_PORT` | Forge のホスト・ポート |
| `SD_FORGE_PYTHON` | Forge 用 Python の起動コマンドまたは `python.exe` パス |
| `MANAGED_COMFYUI` | `0` / `false` で ComfyUI 自動起動を無効化 |
| `COMFYUI_DIR` | ComfyUI のディレクトリ |
| `COMFYUI_HOST` / `COMFYUI_PORT` | ComfyUI のホスト・ポート |

## 起動

```bat
start.bat
```

起動すると、Python サーバーが `http://127.0.0.1:8765` で立ち上がり、Electron ウィンドウが開きます。

## 使い方

### 画像生成

1. 必要なら画像をドラッグ & ドロップして、プロンプトや Seed を読み込みます。
2. Positive Prompt / Negative Prompt を入力します。
3. バックエンドを `WebUI Forge` または `ComfyUI` から選びます。
4. Steps、CFG、Sampler、サイズ、Seed、ComfyUI ワークフローなどを調整します。
5. `画像生成` を押します。

生成画像は画面左に表示されます。保存先は既定で `./outputs/images` です。

### AI チャット

右側のチャット欄から LLM にプロンプト改善を相談できます。AI が次の形式を返すと、Prompt 欄に自動反映されます。

```text
[PROMPT_UPDATE]
Positive: 1girl, sunset, cinematic lighting, ...
Negative: bad quality, blurry, ...
[/PROMPT_UPDATE]
```

システムプロンプトの考え方は [docs/prompts/system_prompt_guide.md](docs/prompts/system_prompt_guide.md) にまとめています。

ライブラリ参照の検索の仕組み（ベクトル検索・FTS5 ハイブリッド・RRF）は [docs/library/library_search.md](docs/library/library_search.md) を参照してください。

### 動画生成

1. 画像生成タブで画像を生成または読み込みます。
2. 動画タブを開きます。
3. 必要なら `動画プロンプト生成` で動画用プロンプトを作ります。
4. ComfyUI の動画ワークフローを選びます。
5. Width / Height / Frames / Seed を調整します。
6. `動画生成` を押します。

生成動画は画面左に表示されます。保存先は既定で `./outputs/videos` です。

### スニペット管理

Snippets タブでは `snippets/` 以下の `.code-snippets` を編集できます。

- `snippets/*.code-snippets`: 共有スニペット
- `snippets/local/*.code-snippets`: ローカル用スニペット

スニペットは Positive / Negative Prompt などの入力欄で補完候補として使われます。

### 画像ライブラリ

Library タブでは画像を登録し、プロンプト生成の参照素材として管理できます。

1. `画像登録` から画像を追加します。
2. PNG メタデータがあれば Positive / Negative Prompt や Seed を抽出します。
3. サムネイル一覧から画像を開き、別ウィンドウで Prompt、Caption、タグ、メモを編集します。
4. `Caption更新` で Vision 対応 LLM に画像説明を生成させます。
5. `再インデックス化` で Qwen3 Embedding を使って保存済みテキストを embedding 化します。

ライブラリのローカルデータは `data/library/` に保存されます。このフォルダは Git 管理対象外です。

#### ライブラリ参照検索

システムプロンプトに `{library_context}` を含めると、LLM へのリクエスト時に類似プロンプトを自動で取得して埋め込みます。「システムプロンプト設定」内で次を調整できます。

| 設定 | 内容 |
|---|---|
| 参照件数 | 取得する類似プロンプトの上限（1〜20） |
| 検索モード | ベクトルのみ（既定）/ FTS5 + ベクトル |

FTS5 + ベクトルモードでは、Reciprocal Rank Fusion で両者の結果を統合します。キャラクター名や LoRA 名などの固有語はベクトル検索よりも FTS5 で拾いやすくなります。詳細は [docs/library/library_search.md](docs/library/library_search.md) を参照してください。

## ComfyUI ワークフロー

ワークフロー JSON は次のフォルダに置きます。

```text
workflows/
  image/   # 画像生成用
  video/   # 動画生成用
```

アプリは JSON を読み込み、主に次のノード値を差し替えます。

- `CLIPTextEncode`: Positive / Negative Prompt
- `KSampler` / `KSamplerAdvanced` / `RandomNoise`: Seed
- `EmptyLatentImage` 系ノード: Width / Height
- `WanImageToVideo` など動画系ノード: Width / Height / Frames
- `LoadImage`: 現在の画像

Negative Prompt は、ノードタイトルや接続先に `negative` / `neg` が含まれるものを優先して判定します。

## ファイル構成

```text
image-assistant/
  server.py                 # FastAPI サーバー、SSE、API
  frontend/                 # HTML / CSS / JS フロントエンド
  electron/                 # Electron メインプロセス
  llm_client.py             # llama-server 管理、OpenAI 互換 API クライアント
  a1111_client.py           # SD WebUI Forge Gradio クライアント
  comfyui_client.py         # ComfyUI REST クライアント、ワークフローパッチ
  sd_process.py             # 管理対象 Forge プロセス
  comfy_process.py          # 管理対象 ComfyUI プロセス
  prompt_parser.py          # PROMPT_UPDATE / PNG メタデータ解析
  settings_manager.py       # settings.json 読み書き
  tools/                    # 開発・調査用の補助スクリプト
  snippets/                 # プロンプトスニペット
  workflows/image/          # 画像生成用 ComfyUI ワークフロー
  workflows/video/          # 動画生成用 ComfyUI ワークフロー
  models/                   # GGUF モデル置き場
  data/library/             # 画像ライブラリ DB・画像・サムネイル
  docs/                     # 補足ドキュメント
    plan/                   # 進捗管理
      goals.md              # 目標
      plan.md               # 計画
      progress.md           # 進捗
    changelog.md            # 変更履歴
    prompts/
      system_prompt_guide.md  # システムプロンプト一覧
      prompt_storage.md       # プロンプト類の保存先
    library/
      library_search.md       # ライブラリ参照検索の仕組み
```

## ログと設定

| ファイル | 内容 |
|---|---|
| `settings.json` | UI 設定、生成パラメータ、保存先など |
| `llama_server.log` | `llama-server` のログ |
| `forge_server.log` | 管理対象 Forge のログ |
| `comfyui_server.log` | 管理対象 ComfyUI のログ |
| `comfyui_server.pid` | 管理対象 ComfyUI の PID |
| `embedding_server.log` | embedding 用 `llama-server` のログ |
| `data/library/library.sqlite3` | 画像ライブラリの SQLite DB |

`settings.json` には Positive / Negative Prompt 本文は保存しない設計です。

## 補足

- Forge 2 は `/sdapi/v1/txt2img` ではなく Gradio API の `/txt2img` を使います。
- ComfyUI の動画生成は完了まで時間がかかるため、SSE でステータスを流しながら待機します。
- `Seed = -1` はランダム生成です。生成後の実 Seed は画像・動画から再利用できます。
- VRAM が足りない場合は、動画生成前に `LLM 解放` または `動画生成前に LLM のメモリを解放する` を使ってください。
