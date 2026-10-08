"""使い方:
    python -m inquiry_bot run   -c config.toml        # 新着を1回処理
    python -m inquiry_bot poll  -c config.toml -i 60  # 60秒ごとに処理し続ける
    python -m inquiry_bot serve -c config.toml        # 転送方式（Webhook 受信）
    python -m inquiry_bot try   -c config.toml mail.eml  # 1通だけ試す（送信・保存しない）
"""

from __future__ import annotations

import argparse
import sys
import time
import traceback
from pathlib import Path

from . import config as config_mod
from .models import Inquiry
from .pipeline import build_reply, format_notification


def run_once(pipeline, source) -> int:
    count = 0
    for inquiry in source.fetch_new():
        result = pipeline.handle(inquiry)
        print(f"[{result}] {inquiry.from_address} {inquiry.subject}")
        count += 1
    return count


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="inquiry_bot")
    parser.add_argument("command", choices=["run", "poll", "serve", "try"])
    parser.add_argument("file", nargs="?")
    parser.add_argument("-c", "--config", default="config.toml")
    parser.add_argument("-i", "--interval", type=int, default=60)
    args = parser.parse_args(argv)

    cfg = config_mod.load(args.config)
    pipeline, source, _ = config_mod.build_pipeline(cfg)

    if args.command == "try":
        if not args.file:
            parser.error("try には .eml ファイルを指定してください")
        inquiry = Inquiry.from_bytes(Path(args.file).read_bytes(), source="try")
        analysis = pipeline.analyzer.analyze(inquiry)
        print(format_notification(inquiry, analysis, "draft"))
        print("\n=== 作成される返信メール ===")
        print(build_reply(inquiry, analysis, pipeline.from_address, pipeline.from_name).as_string())
        return 0

    if args.command == "serve":
        from .sources import serve_webhook

        w = cfg.get("source", {})
        serve_webhook(pipeline.handle, w.get("host", "0.0.0.0"), int(w.get("port", 8025)), w.get("secret", ""))
        return 0

    if source is None:
        parser.error("source.type = webhook のときは serve を使ってください")
    if args.command == "run":
        run_once(pipeline, source)
        return 0

    while True:  # poll
        try:
            run_once(pipeline, source)
        except Exception:
            traceback.print_exc()
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
