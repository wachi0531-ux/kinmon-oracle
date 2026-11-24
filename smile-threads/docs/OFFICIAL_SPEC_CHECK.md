# 公式仕様の確認結果(2026-11-24 時点)

**確認方法**: 公式ドキュメントのURLを検索で特定し、検索結果に出た記述を確認しました。ページ全文を精読できていない項目は「要再確認」としています。**数値(上限・料金・期限)は必ず公式ページで最新を確認してください。**

## ✅ 確認できたこと
| 項目 | 内容 | 出典 |
|---|---|---|
| Threads: 投稿への返信の取得 | `GET /{threads-media-id}/replies`。権限 `threads_read_replies` | [Retrieve replies](https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/retrieve-replies) |
| Threads: 公開返信の投稿 | `reply_to_id` を付けて投稿。権限 `threads_manage_replies` | [Create replies](https://developers.facebook.com/documentation/threads/retrieve-and-manage-replies/create-replies) |
| Threads: 返信の非表示・承認制 | `manage_reply`、`pending_replies` 等 | [Reply management](https://developers.facebook.com/documentation/threads/reply-management) |
| Threads: 投稿は「コンテナ作成→公開」の2段階 | 本システムもこの方式 | [Publishing](https://developers.facebook.com/documentation/threads/reference/publishing) |
| Threads: 投稿・返信には回数上限があり `threads_publishing_limit` で使用量を取得できる | 具体的な数字は要再確認 | 同上 |
| LINE: Webhook署名 | `x-line-signature` = 生のボディのHMAC-SHA256(チャネルシークレット)をBase64化。IP許可リストは当てにしない | [Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/) |
| LINE: 料金(日本) | コミュニケーション/ライト/スタンダードの各プラン。返信メッセージは通数に数えない、プッシュ等は数える | [Messaging API pricing](https://developers.line.biz/ja/docs/messaging-api/pricing/)(追加通数料金は2026-10-01に改定されたとの記載あり。**最新額は必ず公式で確認**) |

## ❌ 確認できなかった/実装しなかったこと
| 項目 | 判断 |
|---|---|
| **Threads DMの取得・送信API** | 公式ドキュメントで提供を確認できず(第三者情報でも「APIなし」)。→ **手入力+返信案方式**。自動取得・自動送信とは表示しません |
| **Threadsの予約投稿パラメータ** | 公式の予約パラメータを確認できず。→ **当サーバーが時刻になったら公式APIで公開**(サーバー常時起動が必要) |
| **Threadsの自動フォロー** | 公式APIで確認できず、規約リスクもあるため**実装しません** |
| Threads→LINE流入の自動特定 | 不可。→ 専用リンク(`/r/コード`)のクリック数+任意アンケートで代用 |
| プロフィールリンクのクリック数 | ユーザー単位のインサイトで取得できる可能性はあるが未確認 → **手入力** |

## ⚠️ 要再確認(実アカウントで確認が必要)
- Threads APIの利用開始条件(アプリ作成、アクセス権限、審査の要否、テスター追加)と権限名
- 投稿の文字数上限(本システムは500字で制限)・1日の投稿/返信上限
- LINE reply token の有効期限(公式の記載を確認できず。受信後すぐに返信する作りにしています)
- Googleカレンダー連携(サービスアカウント方式)は**実アカウントで未検証**
- Threadsの長期トークン更新(`th_refresh_token`)は実装済みだが**実機未検証**

## なぜ Google Apps Script ではなく Node サーバーか
LINE Webhook は **署名ヘッダー(`x-line-signature`)と生ボディの検証が必須**です。Apps Script の `doPost` ではリクエストヘッダーを読めないため、署名検証が実現できません。そのため、署名検証・予約投稿の定時実行・二重投稿防止を安全に行える小さなNodeサーバー(依存パッケージなし)にしました。
