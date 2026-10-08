"""受信方式ごとの差を吸収するインターフェース。

新しいメール環境に対応するときは、この3つを実装したクラスを1つ足すだけでよい。
"""

from __future__ import annotations

from typing import Iterable, Protocol

from ..models import Inquiry


class InboxSource(Protocol):
    """新着の問い合わせを取ってくる。"""

    def fetch_new(self) -> Iterable[Inquiry]: ...


class DraftSink(Protocol):
    """返信案を「下書き」として置く（人が確認して送る）。"""

    def save_draft(self, raw_message: bytes) -> None: ...


class Sender(Protocol):
    """自動返信を実際に送る。"""

    def send(self, raw_message: bytes, to_address: str) -> None: ...
