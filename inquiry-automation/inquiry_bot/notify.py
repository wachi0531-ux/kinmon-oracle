"""担当者への通知。Slack / Chatwork / LINE / Discord / 任意のWebhook / 画面表示。"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass


def _post(url: str, data: bytes, headers: dict[str, str]) -> None:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=15) as resp:
        resp.read()


class ConsoleNotifier:
    def notify(self, text: str) -> None:
        print("----- 通知 -----\n" + text + "\n----------------")


@dataclass
class SlackNotifier:
    webhook_url: str

    def notify(self, text: str) -> None:
        _post(self.webhook_url, json.dumps({"text": text}).encode(), {"Content-Type": "application/json"})


@dataclass
class DiscordNotifier:
    webhook_url: str

    def notify(self, text: str) -> None:
        _post(self.webhook_url, json.dumps({"content": text[:2000]}).encode(), {"Content-Type": "application/json"})


@dataclass
class ChatworkNotifier:
    api_token: str
    room_id: str

    def notify(self, text: str) -> None:
        _post(
            f"https://api.chatwork.com/v2/rooms/{self.room_id}/messages",
            urllib.parse.urlencode({"body": text}).encode(),
            {"X-ChatWorkToken": self.api_token, "Content-Type": "application/x-www-form-urlencoded"},
        )


@dataclass
class LineNotifier:
    """LINE Messaging API の push（LINE Notify は 2025年3月で終了したためこちらを使う）。"""

    channel_access_token: str
    to: str  # 通知先のユーザーID / グループID

    def notify(self, text: str) -> None:
        body = {"to": self.to, "messages": [{"type": "text", "text": text[:5000]}]}
        _post(
            "https://api.line.me/v2/bot/message/push",
            json.dumps(body).encode(),
            {"Authorization": f"Bearer {self.channel_access_token}", "Content-Type": "application/json"},
        )


@dataclass
class WebhookNotifier:
    """Make / Zapier / n8n などに渡したい場合の汎用 Webhook。"""

    url: str

    def notify(self, text: str) -> None:
        _post(self.url, json.dumps({"text": text}).encode(), {"Content-Type": "application/json"})
