"""転送方式とファイル方式。

- WebhookReceiver: 問い合わせメールを自動転送 → 受信サービス（Cloudflare Email Routing の
  Email Worker、SendGrid Inbound Parse、Mailgun Routes など）が生メール(MIME)を POST する。
  IMAP のパスワードを預からなくてよいのが利点。
- EmlDirectory: .eml ファイルを置いたフォルダを読む（動作確認・デモ用）。
"""

from __future__ import annotations

import hmac
import json
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable, Iterator

from ..models import Inquiry


class EmlDirectory:
    def __init__(self, path: str, done_dir: str = ""):
        self.path = Path(path)
        self.done_dir = Path(done_dir) if done_dir else self.path / "processed"

    def fetch_new(self) -> Iterator[Inquiry]:
        self.done_dir.mkdir(parents=True, exist_ok=True)
        for file in sorted(self.path.glob("*.eml")):
            yield Inquiry.from_bytes(file.read_bytes(), source="eml")
            shutil.move(str(file), self.done_dir / file.name)


def serve_webhook(
    handle: Callable[[Inquiry], None],
    host: str,
    port: int,
    secret: str,
    path: str = "/inbound",
) -> None:
    """POST {path} に生メール(message/rfc822)を受けて handle() に渡す。

    認証: ヘッダ `X-Inbound-Secret: <secret>` が一致したものだけ受け付ける。
    SendGrid Inbound Parse の "POST the raw, full MIME message" 形式（multipart の
    `email` フィールド）にも対応する。
    """
    if not secret:
        raise ValueError("webhook の secret を設定してください（誰でも投げ込めてしまうため）")

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path.split("?")[0] != path:
                return self._reply(404, {"error": "not found"})
            if not hmac.compare_digest(self.headers.get("X-Inbound-Secret", ""), secret):
                return self._reply(401, {"error": "unauthorized"})
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 25 * 1024 * 1024:
                return self._reply(413, {"error": "bad size"})
            body = self.rfile.read(length)
            raw = _raw_mime_from_request(self.headers.get("Content-Type", ""), body)
            try:
                handle(Inquiry.from_bytes(raw, source="forward"))
            except Exception as exc:  # 受信元に再送してもらえるよう 500 を返す
                return self._reply(500, {"error": str(exc)})
            self._reply(200, {"ok": True})

        def _reply(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, fmt: str, *args) -> None:
            print("[webhook]", fmt % args)

    print(f"webhook 受付中: http://{host}:{port}{path}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()


def _raw_mime_from_request(content_type: str, body: bytes) -> bytes:
    if content_type.startswith("multipart/form-data"):
        import email
        import email.policy

        form = email.message_from_bytes(
            b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body, policy=email.policy.default
        )
        for part in form.iter_parts():
            if part.get_param("name", header="content-disposition") == "email":
                payload = part.get_payload(decode=True)
                return payload if isinstance(payload, bytes) else str(payload).encode()
        raise ValueError("multipart に email フィールドがありません")
    return body
