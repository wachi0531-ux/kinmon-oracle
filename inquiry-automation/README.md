# 問い合わせ対応の自動化（どのメール環境でも動く版）

```
問い合わせ（Gmail / Outlook / 独自ドメインメール / 転送 …どれでも）
↓
AIが内容を確認（カテゴリ・緊急度・要約）
↓
顧客情報を登録（CSV → Excel / スプレッドシートで開ける）
↓
返信文を作成 → いつものメールアプリの「下書き」に保存
↓
担当者へ通知（Slack / Chatwork / LINE / Discord / Make・Zapier）
↓
定型の問い合わせだけ自動返信（初期設定はオフ）
```

お客さんはメールアプリを変える必要がありません。下書きフォルダに入った返信案を確認して、送信ボタンを押すだけです。

## 仕組み：受信の部分だけを差し替える

| 受信方式 | `source.type` | 対応できるメール | 下書きの置き場所 |
|---|---|---|---|
| IMAP/SMTP | `imap` | Gmail、Microsoft 365 / Outlook、Yahoo、Xserver・さくら・ロリポップなど、ほぼ全部 | 本人のメールの下書きフォルダ |
| 転送（Webhook） | `webhook` | 転送設定ができるメールなら全部 | `[mailbox]` を設定していれば下書きフォルダ、なければ `data/drafts/*.eml` と通知本文 |
| ファイル | `eml_dir` | 動作確認・デモ用 | 同上 |

AIによる確認から通知までの流れ（`inquiry_bot/pipeline.py`）は、どの受信方式でも共通です。新しい受信方式を追加するときは、`inquiry_bot/sources/base.py` の `fetch_new()`（受信）、`save_draft()`（下書き保存）、`send()`（送信）を実装したクラスを1つ足します。Gmail API や Microsoft Graph を使いたい場合も、ここに追加します。

## セットアップ

```bash
cd inquiry-automation
pip install -r requirements.txt
cp config.example.toml config.toml   # お客さんごとに編集する
export ANTHROPIC_API_KEY=...
export MAIL_PASSWORD=...             # config.toml に "env:MAIL_PASSWORD" と書いた値
```

### 1通だけ試す（送信も保存もしない）

```bash
python -m inquiry_bot try -c config.toml samples/sample-inquiry.eml
```

### 本番運用

```bash
python -m inquiry_bot run  -c config.toml          # 新着を1回だけ処理する（cron 向け）
python -m inquiry_bot poll -c config.toml -i 60    # 60秒ごとに処理し続ける
python -m inquiry_bot serve -c config.toml         # 転送方式（Webhook を待ち受ける）
```

転送方式では、Cloudflare Email Routing（Email Worker）、SendGrid Inbound Parse、Mailgun Routes などで受けた生メールを、`POST /inbound` に送ってもらいます。その際、ヘッダ `X-Inbound-Secret` を付ける必要があります。

## メール環境ごとの注意

- **Gmail**：2段階認証を有効にしてから、アプリパスワードを発行して `password` に設定します。
- **Microsoft 365 / Outlook.com**：通常のパスワード認証は使えないため、OAuth のアクセストークンを `oauth2_token` に設定します。会社のアカウントでは、管理者の同意が必要な場合があります。
- **独自ドメインメール（Xserver など）**：サーバーパネルに書かれている IMAP/SMTP の情報をそのまま使えます。設定例は `config.example.toml` にあります。
- **自動返信の送信済み表示**：Gmail 以外のサーバーでは、自動返信が「送信済み」フォルダに残らないことがあります。送った記録は顧客CSVの「対応」列で確認できます。

## 安全のための設計

- 初期設定では自動返信は**オフ**で、すべて下書き止まりです。オンにした場合も、自動返信するのは次の条件をすべて満たすときだけです。
  - `auto_reply.categories` に含まれるカテゴリ
  - AIが「定型で人の判断が不要」と判断した
  - 緊急度が high ではない
  - 同じ相手への自動返信が1日の上限以内
- 自動送信のメール、メルマガ、no-reply アドレスには自動返信しません（返信ループの防止）。送る自動返信には `Auto-Submitted` ヘッダを付けます。
- 処理済みのメールは Message-ID で記録しているため、二重処理や二重返信は起きません。
- AIは `[business] knowledge` に書かれた事実だけを使って返信します。金額や日程などの約束はしません。メール本文に書かれた指示にも従いません。
- パスワードやトークンは設定ファイルに直接書かず、環境変数から読み込みます。

## テスト

```bash
python -m unittest discover -s tests -v
```
