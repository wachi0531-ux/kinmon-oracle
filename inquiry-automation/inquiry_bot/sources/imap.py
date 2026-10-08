"""IMAP/SMTP 方式。Gmail・Outlook・Yahoo・独自ドメインメール（Xserver 等）共通。

認証は2通り:
- password: 通常パスワード / アプリパスワード（独自ドメインメール、Gmail のアプリパスワード）
- oauth2:   XOAUTH2 アクセストークン（Microsoft 365 は原則こちら。Gmail も可）
"""

from __future__ import annotations

import imaplib
import smtplib
import ssl
import time
from dataclasses import dataclass
from typing import Iterator

from ..models import Inquiry


@dataclass
class ImapSettings:
    host: str
    username: str
    password: str = ""
    oauth2_token: str = ""
    port: int = 993
    inbox: str = "INBOX"
    drafts_folder: str = ""  # 空なら SPECIAL-USE (\Drafts) から自動検出
    processed_flag: str = "$AIProcessed"
    since_days: int = 7
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_ssl: bool = False  # True: 465 の SMTPS、False: STARTTLS


def _xoauth2(username: str, token: str) -> bytes:
    return f"user={username}\x01auth=Bearer {token}\x01\x01".encode()


class ImapMailbox:
    """InboxSource + DraftSink + Sender をまとめて実装する。"""

    def __init__(self, settings: ImapSettings):
        self.s = settings
        self._ctx = ssl.create_default_context()

    # ---- 接続 -------------------------------------------------------------
    def _connect(self) -> imaplib.IMAP4_SSL:
        conn = imaplib.IMAP4_SSL(self.s.host, self.s.port, ssl_context=self._ctx)
        if self.s.oauth2_token:
            conn.authenticate("XOAUTH2", lambda _: _xoauth2(self.s.username, self.s.oauth2_token))
        else:
            conn.login(self.s.username, self.s.password)
        return conn

    # ---- 受信 -------------------------------------------------------------
    def fetch_new(self) -> Iterator[Inquiry]:
        conn = self._connect()
        try:
            conn.select(_quote(self.s.inbox))
            since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - self.s.since_days * 86400))
            # 既読/未読はお客さんが普段使いで変えるので頼らない。処理済みは独自フラグで管理。
            typ, data = conn.uid("SEARCH", None, "SINCE", since, "UNKEYWORD", self.s.processed_flag)
            if typ != "OK":
                return
            for uid in data[0].split():
                # BODY.PEEK で取得し、既読にしない
                typ, msg_data = conn.uid("FETCH", uid, "(BODY.PEEK[])")
                if typ != "OK" or not msg_data or not isinstance(msg_data[0], tuple):
                    continue
                inquiry = Inquiry.from_bytes(msg_data[0][1], source=f"imap:{self.s.username}")
                yield inquiry
                # 呼び出し側の処理が例外なく終わったら処理済みフラグを立てる
                conn.uid("STORE", uid, "+FLAGS", f"({self.s.processed_flag})")
        finally:
            _logout(conn)

    # ---- 下書き保存 ---------------------------------------------------------
    def save_draft(self, raw_message: bytes) -> None:
        conn = self._connect()
        try:
            folder = self.s.drafts_folder or _find_drafts(conn) or "Drafts"
            conn.append(_quote(folder), r"(\Draft \Seen)", imaplib.Time2Internaldate(time.time()), raw_message)
        finally:
            _logout(conn)

    # ---- 送信 -------------------------------------------------------------
    def send(self, raw_message: bytes, to_address: str) -> None:
        host = self.s.smtp_host or self.s.host.replace("imap", "smtp", 1)
        if self.s.smtp_ssl:
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(host, self.s.smtp_port, context=self._ctx)
        else:
            smtp = smtplib.SMTP(host, self.s.smtp_port)
            smtp.starttls(context=self._ctx)
        try:
            if self.s.oauth2_token:
                smtp.ehlo()
                import base64

                smtp.docmd("AUTH", "XOAUTH2 " + base64.b64encode(_xoauth2(self.s.username, self.s.oauth2_token)).decode())
            else:
                smtp.login(self.s.username, self.s.password)
            smtp.sendmail(self.s.username, [to_address], raw_message)
        finally:
            smtp.quit()


def _find_drafts(conn: imaplib.IMAP4) -> str | None:
    typ, folders = conn.list()
    if typ != "OK":
        return None
    for line in folders:
        text = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
        if "\\Drafts" in text:
            # 例: (\HasNoChildren \Drafts) "/" "[Gmail]/Drafts"
            return text.rsplit(' "', 1)[-1].rstrip('"') if text.endswith('"') else text.rsplit(" ", 1)[-1]
    return None


def _quote(folder: str) -> str:
    return '"' + folder.replace('"', '\\"') + '"'


def _logout(conn: imaplib.IMAP4) -> None:
    try:
        conn.logout()
    except Exception:
        pass
