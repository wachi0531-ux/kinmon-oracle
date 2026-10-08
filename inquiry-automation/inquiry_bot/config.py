"""config.toml を読み、受信方式に合わせて部品を組み立てる。

パスワード・トークン類は設定ファイルに直接書かず、`env:変数名` と書いて環境変数から読める。
"""

from __future__ import annotations

import os
import tomllib
from pathlib import Path

from . import notify
from .ai import Analyzer, BusinessProfile
from .crm import CsvCustomerLog
from .pipeline import AutoReplyPolicy, DirectoryDraftSink, Pipeline, ProcessedStore
from .sources import EmlDirectory, ImapMailbox, ImapSettings


def _resolve(value):
    if isinstance(value, str) and value.startswith("env:"):
        name = value[4:]
        if name not in os.environ:
            raise KeyError(f"環境変数 {name} が設定されていません")
        return os.environ[name]
    if isinstance(value, dict):
        return {k: _resolve(v) for k, v in value.items()}
    return value


def load(path: str) -> dict:
    return _resolve(tomllib.loads(Path(path).read_text(encoding="utf-8")))


def build_mailbox(cfg: dict) -> ImapMailbox | None:
    m = cfg.get("mailbox")
    return ImapMailbox(ImapSettings(**m)) if m else None


def build_source(cfg: dict, mailbox: ImapMailbox | None):
    kind = cfg.get("source", {}).get("type", "imap")
    if kind == "imap":
        if mailbox is None:
            raise ValueError("source.type = imap には [mailbox] の設定が必要です")
        return mailbox
    if kind == "eml_dir":
        return EmlDirectory(cfg["source"]["path"])
    if kind == "webhook":
        return None  # serve コマンドで受ける
    raise ValueError(f"未対応の source.type: {kind}")


def build_notifiers(cfg: dict) -> list:
    out: list = []
    for n in cfg.get("notify", []):
        t = n.get("type")
        if t == "console":
            out.append(notify.ConsoleNotifier())
        elif t == "slack":
            out.append(notify.SlackNotifier(n["webhook_url"]))
        elif t == "discord":
            out.append(notify.DiscordNotifier(n["webhook_url"]))
        elif t == "chatwork":
            out.append(notify.ChatworkNotifier(n["api_token"], str(n["room_id"])))
        elif t == "line":
            out.append(notify.LineNotifier(n["channel_access_token"], n["to"]))
        elif t == "webhook":
            out.append(notify.WebhookNotifier(n["url"]))
        else:
            raise ValueError(f"未対応の通知先: {t}")
    return out or [notify.ConsoleNotifier()]


def build_pipeline(cfg: dict, analyzer=None) -> tuple[Pipeline, object, ImapMailbox | None]:
    mailbox = build_mailbox(cfg)
    source = build_source(cfg, mailbox)
    data_dir = Path(cfg.get("data_dir", "data"))
    business = cfg.get("business", {})
    profile = BusinessProfile(**{k: v for k, v in business.items() if k in BusinessProfile.__dataclass_fields__})
    reply = cfg.get("reply", {})
    from_address = reply.get("from_address") or (mailbox.s.username if mailbox else "")
    if not from_address:
        raise ValueError("[reply] from_address を設定してください")
    pipeline = Pipeline(
        analyzer=analyzer or Analyzer(profile, model=cfg.get("ai", {}).get("model", "claude-opus-5-5")),
        customers=CsvCustomerLog(cfg.get("crm", {}).get("csv_path", str(data_dir / "customers.csv"))),
        drafts=mailbox or DirectoryDraftSink(str(data_dir / "drafts")),
        notifiers=build_notifiers(cfg),
        store=ProcessedStore(str(data_dir / "state.json")),
        from_address=from_address,
        from_name=reply.get("from_name", profile.company_name),
        sender=mailbox,
        policy=AutoReplyPolicy(**cfg.get("auto_reply", {})),
        ignore_addresses=reply.get("ignore_addresses", []),
    )
    return pipeline, source, mailbox
