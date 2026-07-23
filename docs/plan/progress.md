# Progress

作成日時: 2026-05-19 23:05
更新日時: 2026-07-23 00:00

このファイルは、完了した作業、確認したこと、残っている注意点を共有するための進捗管理ドキュメントです。

## 現在の状態

Image Assistant は、初期の Gradio / A1111 想定から、Electron UI + FastAPI + ローカル `llama-server` + Forge / ComfyUI を組み合わせる構成へ発展している。

現在は、画像生成・動画生成・AI チャット・スニペット管理・画像ライブラリがひと通り揃い、直近では画像ライブラリとライブラリ参照チャットの機能拡張が進んでいる。

最近の更新では、過去画像を保存し、その過去画像を LLM が参照できる情報として蓄積する方向性が強まっている。画像、プロンプト、Caption、tags、notes、embedding を組み合わせ、過去の作例から次のプロンプト精度を高める流れを作っている。

## 完了済みの主な作業

### アプリ基盤

- アプリ名を Image Assistant に変更した。
- Electron のデスクトップ UI と FastAPI サーバー構成に移行した。
- バックエンドを `server.py` から route モジュールへ分割し、共通ユーティリティを抽出した。
- フロントエンドの `app.js` を `frontend/modules/` 以下の ES modules へ分割した。
- `settings.json` にモデル、生成パラメータ、保存先、workflow 選択などを保存する構成にした。

### ローカル LLM

- `llm_client.py` で `llama-server` の OpenAI 互換 API を利用する構成にした。
- `models/` 配下の GGUF モデルをスキャンして選択できるようにした。
- Vision 対応モデルの `mmproj` 検出に対応した。
- LLM モデル選択ボタンと選択モーダルをトップバーに追加した。
- Qwen3 系などの `<think>...</think>` をストリームから除去する処理を入れた。

### 画像生成

- SD WebUI Forge と ComfyUI を画像生成バックエンドとして扱えるようにした。
- Forge / ComfyUI の管理対象プロセス起動と接続状態表示を追加した。
- 画像生成、生成キュー、生成中表示、経過時間表示を追加した。
- PNG メタデータから Positive / Negative Prompt、Seed、生成パラメータを読み取れるようにした。
- 生成画像のリセット時に、表示中の生成画像もクリアするようにした。

### 動画生成

- ComfyUI workflow を使った動画生成に対応した。
- 画像プロンプトと動画ページの専用入力画像をもとに、動画プロンプトを LLM で生成できるようにした。
- Scene / Action / Camera / Style / Final Prompt などのセクション生成に対応した。
- 動画生成完了時の効果音と、効果音のオン・オフ切り替えを追加した。
- 動画ページに専用の入力画像と基画像プロンプト欄を追加し、画像のドロップ時にメタデータと同名JSONの動画プロンプト・追加指示を読み込めるようにした。画像生成ページからの転送にも対応した。
- 動画ページの JSON 保存先を、専用入力画像と同じフォルダ・ファイル名に揃えた。

### AI チャットとプロンプト管理

- 画像生成タブの AI チャットで、現在画像と現在プロンプトを文脈に含められるようにした。
- `[PROMPT_UPDATE]` ブロックを解析し、Positive / Negative Prompt に反映できるようにした。
- チャット用システムプロンプトを `data/chat_prompts.json` に保存する構成にした。
- チャット UI にシステムプロンプト選択、コンテキスト長スライダー、コンテキスト量ゲージ、プロンプトデバッグビューアを追加した。
- ユーザー発言は吹き出し、AI 応答はプレーンテキストに近い表示へ調整した。

### 画像ライブラリ

- 画像ライブラリを追加し、画像・サムネイル・SQLite DB を `data/library/` 配下で管理する構成にした。
- 画像登録時に PNG メタデータからプロンプトや Seed を抽出できるようにした。
- ライブラリ詳細モーダルで Prompt、Caption、tags、notes を編集できるようにした。
- Vision 対応 LLM による Caption 生成と、一括 Caption 生成を追加した。
- Caption 生成時に tags も生成し、保存できるようにした。
- Qwen3 Embedding を使った embedding 作成と再インデックス化を追加した。
- FTS5 とベクトル検索を組み合わせたハイブリッド検索を追加した。
- `{library_context}` を含むチャットプロンプトで、類似プロンプトを LLM に渡せるようにした。
- フォルダ機能、ネストしたフォルダ、ドラッグ並び替え、リネーム、サイドバーリサイズを追加した。
- 複数選択、フォルダへの一括移動、一括削除、ページネーション、無限スクロールを追加した。
- 詳細モーダルに前後移動を追加した。

### スニペット管理

- `snippets/` 配下の `.code-snippets` を UI で検索・編集できるようにした。
- スニペット検索、ヘルプ、アイコン、レイアウト調整を追加した。
- スニペット管理画面の背景とレイアウトをアプリ全体に合わせて調整した。

### UI / 運用

- メインナビゲーションを左サイドバーからトップバーへ移動した。
- SD / ComfyUI のバックエンド操作ボタン、VRAM 表示、ステータス表示をトップバーに整理した。
- GPU / VRAM 取得に必要な `nvidia-ml-py` をアプリ用 `.venv` の依存関係へ追加し、不足時に起動処理で再導入するようにした。
- VRAM 使用状況の詳細内訳をデバッグ表示できるようにした。
- LLM、Forge、ComfyUI のモデル解放やメモリ解放操作を追加した。
- アプリ終了時に関連するコンソール画面も閉じるようにした。

### スニペット（2026-07-22）

- 旧 Image Assistant のスニペット機能を Studio へ移植した（VSCode `.code-snippets` 形式、`snippets/` フォルダは設定 `snippets_root` で変更可）。
- Prompt / Negative Prompt / 動画プロンプトの入力中に prefix の自動候補を表示する
  `frontend/snippet-autocomplete.js` を追加した（↑↓ / Tab / Enter / Esc、候補メニューは body 直下に共有 1 個）。
- スニペットタブをフォーム式編集 UI（ファイル一覧 / 項目一覧＋全ファイル検索 / Name・Prefix・Description・Body フォーム）にし、生 JSON 編集にも切り替え可能にした。`GET /api/snippets/entries` を追加。保存はフロントで JSON を組み立てて既存 `PUT /api/snippets/file` を使う（JSONC のコメントは保存時に失われる）。
- シーケンス編集・スニペット編集で Ctrl+S 保存に対応した。

### 生成結果の配置と NEW 表示（2026-07-22）

- 画像生成 API に `near_item`（元画像 ID）を追加。指定時は `items.place_before` で
  元画像の sort_order ＋ 1e-6 を設定し、一覧（sort_order 降順＝新しいものほど左・上）で
  元画像のすぐ左隣（直前）に並べる。同じ元画像から複数生成した場合は created_at 降順の
  タイブレークで新しい順が保たれる。
- フロントは「✨ この設定で新規生成」（state.genNearId、フォルダ移動でクリア）と
  詳細パネルの「🖼 新規生成でキューに追加」で near_item を渡す。通常のフォルダ生成は従来通り先頭。
- 生成完了時にアイテム ID を localStorage（`studio_new_item_ids`、直近 300 件）へ記録し、
  カードに NEW バッジ（accent 色・点滅）を表示。クリック（handleCardClick / selectItem）で解除。
- 動画にも同様の NEW バッジを追加。キーは「アイテムID/videos/vNNN.mp4」で
  `studio_new_video_ids` に保持し、動画ストリップのカードに表示、handleVideoClick で解除。
- 未確認の新規動画を持つ画像のグリッドカードに「🎞 NEW」（琥珀色 #ffb74d）を表示。
  画像自体の NEW（青）と色で区別。hasNewVideo / pruneNewVideos を追加し、
  動画クリック（handleVideoClick / open-library-item）で解除時に renderGrid、
  selectItem・動画一括削除時に削除済み動画のキーを掃除。
- スニペットファイルの右クリックメニュー（名前を変更 / 削除）を追加。
  リネームは `POST /api/snippets/file/rename`（`snippets.rename_file`、パス検証・重複チェック・
  サブフォルダ移動対応）。削除はツールバーの 🗑 と共通化（deleteFileByPath）。
  スモークテストでリネーム・不正パス拒否を確認。タブ検索は既に全ファイル対象と確認済み。
- スニペット項目のファイル間移動（項目一覧 → ファイル一覧へのドラッグ＆ドロップ）を追加。
  moveEntryToFile は移動先へ追記保存 → 元ファイルから削除保存の順（元ファイルの未保存編集も一緒に確定）。
  移動先の JSON が不正な場合はエラー表示で中断し、元ファイルは変更されない。JSON 編集モード中はドラッグ無効。
- シーケンスのノード右クリックメニューを追加（sequence.js 内で .context-menu を再利用）。
  「ライブラリの元動画を表示」は `open-library-item` カスタムイベントで app.js に通知し、
  app.js 側でタブ切替 → フォルダ/アイテム選択 → 動画プロパティ表示まで行う（モジュール間は疎結合）。
- 検証: `tests/test_generation_service.py` に near_item の配置と参照元欠落時のフォールバックを追加し、
  `test_library_core.py` と合わせて通過。UI は実機での確認が必要（サーバー変更のため要再起動）。
- バグ修正: 動画生成パネル表示中（videoPanel=true）は renderContext が selectedVideoFile より
  生成パネルを優先するため、生成直後の動画をストリップでクリックしてもプロパティに切り替わらなかった。
  handleVideoClick で videoPanel を解除するよう修正。
- グリッド内並べ替えを複数選択ドラッグに対応（internalDragId → internalDragIds、
  reorderItems は選択群をグリッド順のままドロップ位置へ挿入）。フォルダへの複数ドロップ移動は従来通り。
- 動画生成前の LLM アンロード（旧 unload_llm_before_video 相当）を移植。
  `state.genVideo.unload_llm`（既定 true、gen_video として保存）→ enqueueVideoJob で常に params に付与 →
  サーバー `generate_video_for_item` が `params.get("unload_llm", True)` で llama-server を停止。
  チェックボックスは動画生成パネルの Seed と生成ボタンの間。動画プロパティからの再生成にも共通設定が効く。
- 検証: `node --check`、`parse_entries` のスモークテスト、テスト用サーバー（ポート 8799）＋ヘッドレス Chrome のスクリーンショットで UI を確認。候補メニューはヘッドレスのスクリーンショットでのみ描画されない現象があったが、DOM・ヒットテスト・clone 描画・キー操作での挿入はすべて正常で、ヘッドレス固有のコンポジット問題と判断（実機は Ctrl+R 後に要確認）。

### フラットアイコン化（2026-07-23）

- UI の絵文字アイコンを `frontend/icons.js` のフラット SVG アイコン（ストローク系・
  currentColor・24 viewBox、Lucide 風）に置き換えた。サイズは CSS `.ico`（1.2em）で
  フォントサイズに追従する。
- 使い方: 静的 HTML は `data-icon="name"` ＋ `applyStaticIcons()`（app.js 起動時に実行）。
  JS 生成要素は `setIconLabel(el, name, text)`（text は textNode なのでエスケープ不要）
  または `iconSvg(name)`。コンテキストメニューは entries に `icon` フィールドを追加。
- 対象外: ステータス文言内の ⚠（テキストメッセージ）、→ / ↑↓ などの文字記号、
  snippet-autocomplete のキーヒント、コメント内の絵文字。
- 検証: node --check 全ファイル、テスト用サーバー＋ヘッドレス Chrome で
  ライブラリ / シーケンス / スニペット 3 タブのスクリーンショットを確認。
  Ctrl+R で反映可能（フロントのみの変更）。

### サービス状態インジケーターの遷移表示（2026-07-23）

- `/api/status` の各サービスに `state`（ready / starting / installing / error / off）と
  `detail` を追加。HTTP プローブに加え、各プロセスモジュールへ追加した軽量な
  `process_state()`（HTTP プローブ・ロック取得なし）で「プロセスは起動しているが
  まだ応答しない = starting」「異常終了 = error」を判定する。
  - llm_client は load_model 中 `_lock` を最大 120 秒保持するため、`process_state()` は
    ロックを取らずにモジュール変数を直接読む（get_status() は従来通り）。
  - llama-server はモデルロード中 /health が 503 のため「200 = ロード完了」で判定できる。
  - 正常停止時はプロセス変数が None に戻るため、returncode が残っている場合のみ error 扱い。
- フロントのチップは 4 色（灰/琥珀点滅/緑/赤）＋遷移中テキスト（detail 優先）。
  遷移中はポーリングを 8 秒 → 1.5 秒に短縮する setTimeout チェーンに変更。
- 検証: `_resolve_state` の全パターン、テスト用サーバー（8797）での API 応答、
  ヘッドレス Chrome での見た目（5 状態のチップ）、`test_generation_service.py` 通過。
  実際の起動遷移（Forge 起動中→緑）は実機で要確認。サーバー変更のため要再起動。

### バグ修正（2026-07-23）

- ライブラリのフォルダ名を大文字↔小文字だけ変更できなかった問題を修正。Windows の
  ファイルシステムが大文字小文字を区別しないため、`rename_folder` の `dest.exists()` が
  自分自身を検出して「folder already exists」になっていた。`samefile` で同一フォルダと
  判定できた場合のみリネームを許可（別フォルダとの衝突は従来通りエラー）。
  一時ライブラリでの動作確認と `tests/test_library_core.py` 通過を確認。

## 確認済みの補足

- `README.md` は現在の構成にかなり近く、主要機能や起動方法が整理されている。
- `docs/changelog.md` には、2026-02-11 以降の変更が機能のまとまりごとに整理されている。
- `docs/prompts/` には、システムプロンプトとプロンプト保存先の説明がある。
- `docs/library/library_search.md` には、embedding、FTS5、RRF、フォールバックの仕組みが整理されている。
- リポジトリ直下には `package.json` はなく、Electron 側の npm 構成は `electron/` 配下を確認する必要がある。
- 2026-05-19 に、古い Gradio / A1111 仕様書、重複したエージェント向けドキュメント、空のルート `package-lock.json`、単発確認用スクリプトを削除した。
- Forge API 調査用スクリプトは、実行コードから分けるため `tools/discover_forge_api.py` へ移動した。
- ルート直下の実行ログ、Python キャッシュ、旧 Claude ローカル設定ディレクトリをローカル整理として削除した。
- ルート直下のファイル配置方針を `docs/reference/project_structure.md` に記録した。
- 起動時の Python 環境を conda からプロジェクト直下の `.venv` に変更し、`start.bat` で初回セットアップできるようにした。
- Forge 起動時はアプリ用 `.venv` の環境変数と PATH を外し、Forge 側の venv を使えるようにした。
- Forge 用 Python は既存の Forge venv を優先し、未作成時は `py -3.10` や `SD_FORGE_PYTHON` で明示できるようにした。
- 管理対象の ComfyUI、Forge、`llama-server` の配置先を `bin/` から `runtime/` へ変更し、旧設定パスの読み替えに対応した。
- Forge の `config.json` に残るVAEなどの旧絶対パスを、起動前に現在の配置先へ移行するようにした。

## 残っている注意点

- `docs/plan/goals.md`、`docs/plan/plan.md`、`docs/plan/progress.md` は今回、履歴から逆算した暫定整理であり、実際の優先順位は今後の作業で更新する。
- 画像ライブラリは機能が増えているため、登録・検索・一括操作・詳細編集・フォルダ操作の回帰確認が重要。
- Embedding サーバー、Forge、ComfyUI、ローカル LLM は環境依存が強いため、検証時は起動状態とログを確認する。
- FTS5 + ベクトル検索は便利だが、固有語・日本語・LoRA 名などで期待通り拾えるか実データで確認が必要。
- Caption / tags 生成は LLM 返答 JSON の品質に依存するため、失敗時の保存内容と UI 表示を確認する。
- ComfyUI workflow のノード差し替えは workflow ごとの構造差に左右されるため、代表 workflow で継続確認する。
- 未コミット変更がある作業ツリーでは、ユーザー作業を戻さず、変更範囲を限定する。
