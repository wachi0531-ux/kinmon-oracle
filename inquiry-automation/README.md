# 問い合わせ対応の自動化（どのメール環境でも動く版）

```
問い合わせ（Gmail / Outlook / 独自ドメインメール / 転送 …どれでも）
↓
AIが内容を確認（カテゴリ・緊急度・要約）※ ChatGPT（OpenAI）/ Claude を選べる
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

## はじめて動かす手順（自分のPCで確認する）

### 0. 準備するもの
- Python 3.11 以上（Windows は https://www.python.org/ から。インストール時に「Add python.exe to PATH」にチェック）
- OpenAI の APIキー（https://platform.openai.com/api-keys で発行。ChatGPT Plus とは別契約で、APIは従量課金。1通あたり数円程度以下）

### 1. ダウンロードとインストール
```bash
git clone -b claude/email-inquiry-automation-threqb https://github.com/wachi0531-ux/kinmon-oracle.git
cd kinmon-oracle/inquiry-automation
pip install -r requirements.txt
cp config.example.toml config.toml      # Windows は copy config.example.toml config.toml
```

### 2. APIキーを設定
```bash
export OPENAI_API_KEY="sk-..."          # Mac
set OPENAI_API_KEY=sk-...               # Windows（コマンドプロンプト）
```

### 3. メールアカウント無しで AI の出来を確認する（送信も保存もしない）
`samples/` に、資料請求・見積依頼・クレーム・営業メールの4通の例が入っています。
```bash
python -m inquiry_bot try -c config.toml samples/1-shiryo.eml
python -m inquiry_bot try -c config.toml samples/3-claim.eml
```
カテゴリ・要約・顧客情報・返信案が画面に出ます。`config.toml` の `[business]`（会社名・署名・`knowledge`）を書き換えると返信文が変わります。

### 4. 実際のメール（Gmail の例）で動かす
1. Google アカウントで2段階認証を有効にして「アプリパスワード」を発行する
2. `config.toml` の `[mailbox]` の `username` を自分のアドレスにする（`host` などは Gmail 用のまま）
3. 実行する
```bash
export MAIL_PASSWORD="発行したアプリパスワード"
python -m inquiry_bot run -c config.toml
```
4. Gmail の「下書き」に返信案が入り、`data/customers.csv` に顧客情報が追記されていることを確認する
   （直近7日分の受信メールが対象です。元のメールは既読になりません）

うまくいったら `poll`（定期実行）や通知先（Slack / Chatwork / LINE）を設定します。

## コマンド一覧

```bash
python -m inquiry_bot try   -c config.toml mail.eml  # 1通だけ試す（送信・保存しない）
python -m inquiry_bot run   -c config.toml           # 新着を1回だけ処理する（cron 向け）
python -m inquiry_bot poll  -c config.toml -i 60     # 60秒ごとに処理し続ける
python -m inquiry_bot serve -c config.toml           # 転送方式（Webhook を待ち受ける）
```

転送方式では、Cloudflare Email Routing（Email Worker）、SendGrid Inbound Parse、Mailgun Routes などで受けた生メールを、`POST /inbound` に送ってもらいます。その際、ヘッダ `X-Inbound-Secret` を付ける必要があります。

## AI の切り替え

`config.toml` の `[ai]` で選びます。

| provider | 必要な環境変数 | 標準モデル |
|---|---|---|
| `openai`（ChatGPT） | `OPENAI_API_KEY` | `gpt-5-mini`（`model` で変更可） |
| `anthropic`（Claude） | `ANTHROPIC_API_KEY` | `claude-opus-5-5` |

どちらも JSON の形を強制する機能（Structured Outputs）を使っているため、出力の崩れで止まることはありません。

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
