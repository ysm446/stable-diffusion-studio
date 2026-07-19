# プロンプト類の保存先

このドキュメントは、Image Assistant で編集・利用されるプロンプト類がどこに保存されるかをまとめたものです。

## 保存されるプロンプト

| 種類 | 保存先 | 主な実装 | 用途 |
| --- | --- | --- | --- |
| AI チャット用プロンプト | `data/chat_prompts.json` | `chat_prompt_store.py` | 画像生成タブの AI チャット、プロンプト修正、ライブラリ参照チャットなど |
| ライブラリー Caption 生成プロンプト | `data/library/caption_prompts.json` | `caption_prompt_store.py` | ライブラリー画像の Caption 生成、Caption 一括生成 |

どちらも JSON ファイルとして保存されます。ファイルが存在しない場合は、アプリ起動後の読み込み時に既定プロンプトから自動生成されます。

## `data/chat_prompts.json`

画像生成タブの AI チャットで使うプロンプト設定です。

保存される主な項目:

```json
{
  "prompts": [
    {
      "id": "review",
      "name": "プロンプト名",
      "system_prompt": "LLM に渡す system prompt",
      "created_at": 0,
      "updated_at": 0
    }
  ],
  "deleted_defaults": []
}
```

`deleted_defaults` は、既定プロンプトをユーザーが削除した状態を保持するために使われます。

利用箇所:

- `/api/chat/stream`
- `/api/video_prompt/stream`
- AI チャットのシステムプロンプト設定 UI

主な差し込み変数:

```text
{positive_prompt}
{negative_prompt}
{library_context}
```

## `data/library/caption_prompts.json`

ライブラリー画像の Caption 生成で使うプロンプト設定です。

保存される主な項目:

```json
{
  "prompts": [
    {
      "id": "visual",
      "name": "画像のみ",
      "system_prompt": "Caption 生成用の system prompt",
      "user_prompt": "Caption 生成用の user prompt",
      "created_at": 0,
      "updated_at": 0
    }
  ]
}
```

利用箇所:

- `/api/library/images/{image_id}/caption`
- `/api/library/images/{image_id}/caption/stream`
- `/api/library/batch_caption/stream`
- ライブラリー詳細画面の Caption プロンプト設定 UI

既定の Caption 生成プロンプトは、LLM に次のような JSON のみを返すよう指示します。

```json
{
  "caption": "画像の説明文",
  "tags": ["犬", "パグ", "小型犬", "ペット"]
}
```

サーバー側は返答 JSON をパースし、`caption` と `tags` を分けて保存します。JSON として読めない返答の場合は、従来通り返答全文を Caption 本文として保存します。

主な差し込み変数:

```text
{positive_prompt}
{negative_prompt}
{notes}
{filename}
{tags}
```

## 生成結果の保存先

プロンプト設定そのものと、LLM が生成した結果は別の場所に保存されます。

| 内容 | 保存先 | 備考 |
| --- | --- | --- |
| ライブラリー Caption 本文 | `data/library/library.sqlite3` の `library_images.caption` | 通常のテキストとして保存 |
| ライブラリー Tags | `data/library/library.sqlite3` の `library_images.tags` | カンマ区切り文字列として保存され、読み込み時に配列化 |
| 画像プロンプトのメタデータ | `data/library/library.sqlite3` の `positive_prompt` / `negative_prompt` | PNG メタデータや登録時情報から保存 |

## 保存されないもの

次のような値は、プロンプト設定ファイルには保存されません。

- 画像生成タブの現在の Positive / Negative Prompt 本文
- チャットの一時的な会話履歴
- Caption 生成時に LLM へ送信された最終的な展開済みプロンプト

現在の Positive / Negative Prompt などの UI 設定は、必要な範囲だけ `settings.json` やアプリ状態で扱われます。プロンプト設定ファイルには、テンプレートとしての `system_prompt` / `user_prompt` だけが保存されます。

## 関連ドキュメント

- [system_prompt_guide.md](system_prompt_guide.md)
- [library_search.md](../library/library_search.md)
