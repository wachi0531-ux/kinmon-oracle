"""顧客情報の登録先。標準は CSV（Excel / Googleスプレッドシートで開ける）。

kintone・HubSpot・Notion などに入れたい場合は、同じ record() を持つクラスを足す。
"""

from __future__ import annotations

import csv
import threading
from pathlib import Path

from .models import Analysis, Inquiry

FIELDS = [
    "受信日時", "メールアドレス", "名前", "会社名", "電話番号",
    "カテゴリ", "緊急度", "要約", "件名", "対応", "受信元", "Message-ID",
]


class CsvCustomerLog:
    """問い合わせ1件=1行で追記する（同じ人の履歴も追える）。"""

    _lock = threading.Lock()

    def __init__(self, path: str):
        self.path = Path(path)

    def record(self, inquiry: Inquiry, analysis: Analysis, action: str) -> None:
        row = {
            "受信日時": inquiry.received_at.isoformat(),
            "メールアドレス": analysis.customer.email,
            "名前": analysis.customer.name,
            "会社名": analysis.customer.company,
            "電話番号": analysis.customer.phone,
            "カテゴリ": analysis.category,
            "緊急度": analysis.urgency,
            "要約": analysis.summary,
            "件名": inquiry.subject,
            "対応": action,
            "受信元": inquiry.source,
            "Message-ID": inquiry.message_id,
        }
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            is_new = not self.path.exists()
            # utf-8-sig: Excel で開いても文字化けしない
            with self.path.open("a", newline="", encoding="utf-8-sig" if is_new else "utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=FIELDS)
                if is_new:
                    writer.writeheader()
                writer.writerow(row)
