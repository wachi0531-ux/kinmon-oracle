"""問い合わせ1件の処理の流れ（受信方式に関係なく共通）。

問い合わせ → AIが内容を確認 → 顧客情報を登録 → 返信文を作成
→ （定型なら自動返信 / それ以外は下書き保存） → 担当者へ通知
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid
from pathlib import Path
from typing import Protocol

from .models import Analysis, Inquiry


class AnalyzerLike(Protocol):
    def analyze(self, inquiry: Inquiry) -> Analysis: ...


class Notifier(Protocol):
    def notify(self, text: str) -> None: ...


class CustomerLog(Protocol):
    def record(self, inquiry: Inquiry, analysis: Analysis, action: str) -> None: ...


@dataclass
class AutoReplyPolicy:
    enabled: bool = False  # 最初は全部「下書き止まり」で始める
    categories: list[str] = field(default_factory=lambda: ["資料請求"])
    max_per_sender_per_day: int = 1


class ProcessedStore:
    """処理済み Message-ID を記録して、二重処理・二重返信を防ぐ。"""

    _lock = threading.Lock()

    def __init__(self, path: str):
        self.path = Path(path)
        self._data: dict = json.loads(self.path.read_text()) if self.path.exists() else {}
        self._data.setdefault("processed", {})
        self._data.setdefault("auto_replied", {})

    def seen(self, message_id: str) -> bool:
        return message_id in self._data["processed"]

    def mark(self, message_id: str, action: str) -> None:
        with self._lock:
            self._data["processed"][message_id] = action
            self._save()

    def auto_replies_today(self, address: str, day: str) -> int:
        return self._data["auto_replied"].get(f"{day}:{address}", 0)

    def add_auto_reply(self, address: str, day: str) -> None:
        with self._lock:
            key = f"{day}:{address}"
            self._data["auto_replied"][key] = self._data["auto_replied"].get(key, 0) + 1
            self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1))
        tmp.replace(self.path)


class DirectoryDraftSink:
    """メールボックスに入れられない場合（転送方式のみ等）の下書き置き場。"""

    def __init__(self, path: str):
        self.path = Path(path)

    def save_draft(self, raw_message: bytes) -> None:
        self.path.mkdir(parents=True, exist_ok=True)
        n = len(list(self.path.glob("*.eml"))) + 1
        (self.path / f"draft-{n:05d}.eml").write_bytes(raw_message)


@dataclass
class Pipeline:
    analyzer: AnalyzerLike
    customers: CustomerLog
    drafts: object  # DraftSink
    notifiers: list[Notifier]
    store: ProcessedStore
    from_address: str
    from_name: str = ""
    sender: object | None = None  # Sender（自動返信を使う場合のみ必要）
    policy: AutoReplyPolicy = field(default_factory=AutoReplyPolicy)
    ignore_addresses: list[str] = field(default_factory=list)

    def handle(self, inquiry: Inquiry) -> str:
        if self.store.seen(inquiry.message_id):
            return "skip:duplicate"
        if inquiry.from_address in {a.lower() for a in [self.from_address, *self.ignore_addresses]}:
            self.store.mark(inquiry.message_id, "skip:self")
            return "skip:self"

        analysis = self.analyzer.analyze(inquiry)

        if analysis.is_spam_or_sales:
            action = "skip:spam_or_sales"
            self.customers.record(inquiry, analysis, action)
            self.store.mark(inquiry.message_id, action)
            return action

        action = "draft"
        if self._can_auto_reply(inquiry, analysis):
            reply = build_reply(inquiry, analysis, self.from_address, self.from_name, automatic=True)
            self.sender.send(reply.as_bytes(), inquiry.from_address)  # type: ignore[union-attr]
            self.store.add_auto_reply(inquiry.from_address, inquiry.received_at.date().isoformat())
            action = "auto_replied"
        else:
            reply = build_reply(inquiry, analysis, self.from_address, self.from_name)
            self.drafts.save_draft(reply.as_bytes())  # type: ignore[attr-defined]

        self.customers.record(inquiry, analysis, action)
        self.store.mark(inquiry.message_id, action)
        text = format_notification(inquiry, analysis, action)
        for n in self.notifiers:
            try:
                n.notify(text)
            except Exception as exc:  # 通知失敗で処理全体を止めない
                print(f"[warn] 通知に失敗: {type(n).__name__}: {exc}")
        return action

    def _can_auto_reply(self, inquiry: Inquiry, analysis: Analysis) -> bool:
        p = self.policy
        return (
            p.enabled
            and self.sender is not None
            and analysis.auto_reply_ok
            and analysis.category in p.categories
            and analysis.urgency != "high"
            and not inquiry.is_automated()
            and self.store.auto_replies_today(inquiry.from_address, inquiry.received_at.date().isoformat())
            < p.max_per_sender_per_day
        )


def build_reply(
    inquiry: Inquiry, analysis: Analysis, from_address: str, from_name: str = "", automatic: bool = False
) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = formataddr((from_name, from_address)) if from_name else from_address
    msg["To"] = formataddr((inquiry.from_name, inquiry.from_address)) if inquiry.from_name else inquiry.from_address
    subject = analysis.reply_subject or inquiry.subject
    if not subject.lower().startswith("re:"):
        subject = "Re: " + (inquiry.subject or subject)
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg["Message-ID"] = make_msgid(domain=from_address.split("@")[-1])
    # スレッドとしてつながるように
    msg["In-Reply-To"] = inquiry.message_id
    msg["References"] = (inquiry.references + " " + inquiry.message_id).strip()
    if automatic:
        # 相手側の自動返信と無限ループしないように（人が送る下書きには付けない）
        msg["Auto-Submitted"] = "auto-replied"
    quoted = "\n".join("> " + line for line in inquiry.body.splitlines()[:40])
    msg.set_content(f"{analysis.reply_body}\n\n{quoted}\n")
    return msg


URGENCY_LABEL = {"high": "🔴 至急", "normal": "🟡 通常", "low": "⚪ 低"}
ACTION_LABEL = {"draft": "返信案を下書きに保存しました（確認して送信してください）", "auto_replied": "定型のため自動返信しました"}


def format_notification(inquiry: Inquiry, analysis: Analysis, action: str) -> str:
    c = analysis.customer
    who = " / ".join(x for x in [c.company, c.name, c.email, c.phone] if x)
    lines = [
        f"📩 新しい問い合わせ [{analysis.category}] {URGENCY_LABEL.get(analysis.urgency, analysis.urgency)}",
        f"差出人: {who}",
        f"件名: {inquiry.subject}",
        f"要約: {analysis.summary}",
        f"対応: {ACTION_LABEL.get(action, action)}",
    ]
    if analysis.needs_human_reason:
        lines.append(f"確認ポイント: {analysis.needs_human_reason}")
    if action == "draft":
        lines += ["", "--- 返信案 ---", analysis.reply_body]
    return "\n".join(lines)
