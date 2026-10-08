"""メールの種類に依存しない共通データ型。

どの受信方式（IMAP / 転送 / API）から来たメールも、まず Inquiry に変換する。
後ろの処理（AI確認・顧客登録・返信文・通知）は Inquiry だけを見て動く。
"""

from __future__ import annotations

import email
import email.policy
import email.utils
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email.message import EmailMessage


@dataclass
class Inquiry:
    message_id: str
    from_name: str
    from_address: str
    subject: str
    body: str
    received_at: datetime
    source: str  # 例: "imap:info@example.com", "forward", "eml"
    in_reply_to: str = ""
    references: str = ""
    headers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_bytes(cls, raw: bytes, source: str) -> "Inquiry":
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        return cls.from_message(msg, source)

    @classmethod
    def from_message(cls, msg: EmailMessage, source: str) -> "Inquiry":
        name, address = email.utils.parseaddr(str(msg.get("Reply-To") or msg.get("From", "")))
        date_header = msg.get("Date")
        try:
            received = email.utils.parsedate_to_datetime(str(date_header)) if date_header else None
        except (TypeError, ValueError):
            received = None
        message_id = str(msg.get("Message-ID", "")).strip()
        if not message_id:
            # Message-ID が無いメールもあるので、内容から安定したIDを作る
            import hashlib

            message_id = "<generated-" + hashlib.sha256(msg.as_bytes()).hexdigest()[:24] + ">"
        watched = ("Auto-Submitted", "Precedence", "List-Id", "List-Unsubscribe", "X-Auto-Response-Suppress")
        return cls(
            message_id=message_id,
            from_name=name,
            from_address=address.lower(),
            subject=str(msg.get("Subject", "")),
            body=_extract_text(msg),
            received_at=received or datetime.now(timezone.utc),
            source=source,
            in_reply_to=str(msg.get("In-Reply-To", "")),
            references=str(msg.get("References", "")),
            headers={k: str(msg[k]) for k in watched if msg.get(k) is not None},
        )

    def is_automated(self) -> bool:
        """自動送信メール・メルマガ・no-reply か（自動返信のループ防止に使う）。"""
        auto = self.headers.get("Auto-Submitted", "no").lower()
        if auto and auto != "no":
            return True
        if self.headers.get("Precedence", "").lower() in {"bulk", "list", "junk"}:
            return True
        if "List-Id" in self.headers or "List-Unsubscribe" in self.headers:
            return True
        local = self.from_address.split("@")[0]
        return bool(re.match(r"^(no-?reply|do-?not-?reply|mailer-daemon|postmaster)", local))


def _extract_text(msg: EmailMessage) -> str:
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    text = part.get_content()
    if part.get_content_type() == "text/html":
        text = re.sub(r"(?is)<(script|style).*?</\1>", "", text)
        text = re.sub(r"(?i)<br\s*/?>|</p>", "\n", text)
        text = re.sub(r"<[^>]+>", "", text)
        import html

        text = html.unescape(text)
    return text.strip()


@dataclass
class Customer:
    name: str = ""
    company: str = ""
    email: str = ""
    phone: str = ""


@dataclass
class Analysis:
    category: str  # 例: 見積依頼 / 資料請求 / 予約 / クレーム / 営業 / その他
    urgency: str  # "high" | "normal" | "low"
    summary: str
    customer: Customer
    reply_subject: str
    reply_body: str
    auto_reply_ok: bool  # 定型で人の判断が不要か（AIの判断）
    needs_human_reason: str
    is_spam_or_sales: bool
