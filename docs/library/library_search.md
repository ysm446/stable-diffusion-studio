# ライブラリ参照の検索の仕組み

AI チャットのシステムプロンプトに `{library_context}` を含めると、ユーザーの発言に類似したプロンプトをライブラリから自動取得して LLM に渡します。このドキュメントは、その検索の内部処理を説明します。

実装箇所は [image_library.py](../image_library.py) と [helpers.py](../helpers.py) です。

## 全体の流れ

```
ユーザー発言
    │
    ├─ [ベクトル検索] embed_text() → search_by_embedding()
    │
    ├─ [FTS5 検索] search_by_fts()   ← ハイブリッドモードのみ
    │
    └─ RRF で統合 → build_library_context() → {library_context} に展開
```

## 検索モード

システムプロンプト設定の「検索モード」ドロップダウンで切り替えます。

| モード | 内容 |
|---|---|
| ベクトルのみ | コサイン類似度による意味的検索（デフォルト） |
| FTS5 + ベクトル | 全文検索との併用（ハイブリッド） |

選択は `localStorage` で保持されます（`settings.json` には保存しません）。

## ベクトル検索

### インデックス作成

画像ライブラリの詳細画面から「再インデックス化」を実行すると、各画像の次のフィールドを結合してテキストを作り、Qwen3 Embedding でベクトル化して SQLite に保存します。

```python
# image_library.py — text_for_embedding()
"Filename: {filename}"
"Tags: {tags}"
"Positive prompt: {positive_prompt}"
"Negative prompt: {negative_prompt}"
"Caption: {caption}"
"Notes: {notes}"
```

ベクトルは `float32` をリトルエンディアンでパックしたバイナリとして `embedding` カラムに格納します。

### 検索

`search_by_embedding(query_vector, limit)` は全行を Python 側でスキャンし、クエリベクトルとのコサイン類似度を計算して上位 `limit` 件を返します。

```
cosine(q, v) = (q · v) / (|q| × |v|)
```

sqlite-vec などの拡張は使わず、`struct.unpack` でバイナリを展開して計算しています。

## FTS5 全文検索

### インデックス

SQLite の FTS5 仮想テーブル `library_images_fts` を使います。`library_images` をコンテンツテーブルとし、次のカラムをインデックス対象にしています。

```sql
CREATE VIRTUAL TABLE library_images_fts USING fts5(
    positive_prompt, negative_prompt, tags, caption, notes,
    content='library_images', content_rowid='id'
);
```

INSERT / UPDATE / DELETE トリガーで自動的に同期します。DB 初回起動時（テーブルが存在しなかった場合）は `rebuild` コマンドで既存データを一括インデックス化します。

FTS5 の既定トークナイザ `unicode61` は記号を区切り文字として扱います。SD プロンプト特有の `<lora:name:0.8>` は `lora`・`name`・`0`・`8` にトークン分割されます。

### クエリ

ユーザー発言を正規表現 `\w+` で単語に分割し、各単語を二重引用符で囲んで完全一致クエリを組み立てます。最大 20 トークンまで使用します。

```python
# 例: "kimono sitting 1girl"
fts_query = '"kimono" "sitting" "1girl"'
```

FTS5 の `rank` カラム（スコアの逆数で昇順）でソートして返します。

## ハイブリッド検索と RRF

`search_hybrid(query_vector, query_text, limit)` は、ベクトル検索と FTS5 検索の結果を **Reciprocal Rank Fusion (RRF)** で統合します。

### RRF の計算式

それぞれの検索結果でのランク順位を `rank_vec`・`rank_fts` として、各文書のスコアを次式で求めます。

```
score(d) = 1 / (k + rank_vec(d))  +  1 / (k + rank_fts(d))
```

- `k = 60`（RRF の平滑化定数。lm-chat の実装を参考にした値）
- 一方の検索にしか出ない文書は、その項だけ加算します
- スコア降順で上位 `limit` 件を返します

### 例

| 文書 | rank_vec | rank_fts | スコア |
|---|---:|---:|---:|
| A | 1 | 3 | 1/61 + 1/63 ≈ 0.0321 |
| B | 2 | 1 | 1/62 + 1/61 ≈ 0.0326 |
| C | 3 | — | 1/63 ≈ 0.0159 |
| D | — | 2 | 1/62 ≈ 0.0161 |

B が最上位になります（ベクトルで 2 位 + FTS5 で 1 位の組み合わせが、どちらかで 1 位のものより高い）。

### プール数

RRF に渡す前の候補数は `limit × 4` です。最終的に上位 `limit` 件を `{library_context}` に展開します。

## フォールバック

ベクトル検索が失敗した場合（Embedding サーバー未起動など）は、キーワード LIKE 検索にフォールバックします。

```python
# helpers.py — build_library_context()
all_items = image_library.list_images(query=user_input)
items = [i for i in all_items if i.get("positive_prompt")][:limit]
```

## UI 設定

「システムプロンプト設定」アコーディオン内にあります。

| 設定 | 説明 |
|---|---|
| 参照件数 | 取得する類似プロンプトの上限（1〜20、既定 5） |
| 検索モード | 「ベクトルのみ」または「FTS5 + ベクトル」 |

`{library_context}` を含まないシステムプロンプトを選択している場合、検索は実行されません。

## 検索モードの使い分け

| 状況 | 推奨モード |
|---|---|
| ライブラリに embedding が十分に入っている | どちらでも可 |
| embedding 未作成の画像が多い | FTS5 + ベクトル |
| キャラクター名・LoRA 名など固有語で検索したい | FTS5 + ベクトル |
| 意味的な近さを優先したい | ベクトルのみ |
