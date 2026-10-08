import csv
import json
import tempfile
import threading
import unittest
import urllib.request
from email.message import EmailMessage
from pathlib import Path
from types import SimpleNamespace

from inquiry_bot.ai import Analyzer, BusinessProfile, parse_analysis
from inquiry_bot.crm import CsvCustomerLog
from inquiry_bot.models import Inquiry
from inquiry_bot.pipeline import AutoReplyPolicy, DirectoryDraftSink, Pipeline, ProcessedStore
from inquiry_bot.sources import EmlDirectory


def make_raw(sender="山田 太郎 <taro@example.co.jp>", subject="資料をください", body="資料を送ってください。", **headers) -> bytes:
    m = EmailMessage()
    m["From"] = sender
    m["To"] = "info@shop.example"
    m["Subject"] = subject
    m["Message-ID"] = headers.pop("message_id", "<abc123@example.co.jp>")
    m["Date"] = "Wed, 07 Oct 2026 10:00:00 +0900"
    for k, v in headers.items():
        m[k.replace("_", "-")] = v
    m.set_content(body)
    return m.as_bytes()


AI_RESULT = {
    "category": "資料請求",
    "urgency": "normal",
    "summary": "サービス資料の送付依頼",
    "customer": {"name": "山田 太郎", "company": "山田商事", "email": "taro@example.co.jp", "phone": "03-0000-0000"},
    "reply_subject": "Re: 資料をください",
    "reply_body": "山田様\n資料をお送りいたします。",
    "auto_reply_ok": True,
    "needs_human_reason": "",
    "is_spam_or_sales": False,
}


class FakeAnalyzer:
    def __init__(self, result=None):
        self.result = result or AI_RESULT
        self.calls = 0

    def analyze(self, inquiry):
        self.calls += 1
        return parse_analysis(dict(self.result), inquiry)


class Recorder:
    def __init__(self):
        self.items = []

    def save_draft(self, raw):
        self.items.append(raw)

    def send(self, raw, to):
        self.items.append((raw, to))

    def notify(self, text):
        self.items.append(text)


class PipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.drafts, self.sender, self.notifier = Recorder(), Recorder(), Recorder()

    def make(self, analyzer=None, policy=None):
        return Pipeline(
            analyzer=analyzer or FakeAnalyzer(),
            customers=CsvCustomerLog(str(self.tmp / "customers.csv")),
            drafts=self.drafts,
            notifiers=[self.notifier],
            store=ProcessedStore(str(self.tmp / "state.json")),
            from_address="info@shop.example",
            from_name="ショップ",
            sender=self.sender,
            policy=policy or AutoReplyPolicy(),
        )

    def test_default_saves_draft_records_customer_and_notifies(self):
        p = self.make()
        self.assertEqual(p.handle(Inquiry.from_bytes(make_raw(), "test")), "draft")
        self.assertEqual(len(self.drafts.items), 1)
        self.assertEqual(self.sender.items, [])
        draft = self.drafts.items[0].decode()
        self.assertIn("In-Reply-To: <abc123@example.co.jp>", draft)
        self.assertNotIn("Auto-Submitted", draft)
        rows = list(csv.DictReader((self.tmp / "customers.csv").open(encoding="utf-8-sig")))
        self.assertEqual(rows[0]["会社名"], "山田商事")
        self.assertIn("返信案", self.notifier.items[0])

    def test_duplicate_is_skipped(self):
        ai = FakeAnalyzer()
        p = self.make(ai)
        p.handle(Inquiry.from_bytes(make_raw(), "test"))
        self.assertEqual(p.handle(Inquiry.from_bytes(make_raw(), "test")), "skip:duplicate")
        self.assertEqual(ai.calls, 1)

    def test_auto_reply_when_enabled_and_allowed(self):
        p = self.make(policy=AutoReplyPolicy(enabled=True, categories=["資料請求"]))
        self.assertEqual(p.handle(Inquiry.from_bytes(make_raw(), "test")), "auto_replied")
        raw, to = self.sender.items[0]
        self.assertEqual(to, "taro@example.co.jp")
        self.assertIn(b"Auto-Submitted: auto-replied", raw)
        # 同じ人には1日1回まで
        second = Inquiry.from_bytes(make_raw(message_id="<other@example.co.jp>"), "test")
        self.assertEqual(p.handle(second), "draft")

    def test_no_auto_reply_for_other_category_or_automated_mail(self):
        policy = AutoReplyPolicy(enabled=True, categories=["資料請求"])
        p = self.make(FakeAnalyzer({**AI_RESULT, "category": "クレーム"}), policy)
        self.assertEqual(p.handle(Inquiry.from_bytes(make_raw(), "t")), "draft")
        p = self.make(policy=policy)
        raw = make_raw(message_id="<x@y>", Auto_Submitted="auto-replied")
        self.assertEqual(p.handle(Inquiry.from_bytes(raw, "t")), "draft")
        noreply = make_raw(sender="no-reply@service.example", message_id="<z@y>")
        self.assertEqual(p.handle(Inquiry.from_bytes(noreply, "t")), "draft")

    def test_spam_is_logged_but_not_drafted(self):
        p = self.make(FakeAnalyzer({**AI_RESULT, "is_spam_or_sales": True}))
        self.assertEqual(p.handle(Inquiry.from_bytes(make_raw(), "t")), "skip:spam_or_sales")
        self.assertEqual(self.drafts.items, [])

    def test_own_address_is_ignored(self):
        p = self.make()
        raw = make_raw(sender="info@shop.example")
        self.assertEqual(p.handle(Inquiry.from_bytes(raw, "t")), "skip:self")


class SourcesTest(unittest.TestCase):
    def test_html_only_mail(self):
        m = EmailMessage()
        m["From"] = "a@b.c"
        m["Subject"] = "x"
        m.set_content("<p>こんにちは<br>よろしく&amp;</p>", subtype="html")
        self.assertEqual(Inquiry.from_bytes(m.as_bytes(), "t").body, "こんにちは\nよろしく&")

    def test_eml_directory(self):
        d = Path(tempfile.mkdtemp())
        (d / "1.eml").write_bytes(make_raw())
        got = list(EmlDirectory(str(d)).fetch_new())
        self.assertEqual(got[0].from_address, "taro@example.co.jp")
        self.assertFalse((d / "1.eml").exists())

    def test_webhook(self):
        import http.server

        from inquiry_bot.sources import forward

        received = []
        server_box = {}
        orig = http.server.ThreadingHTTPServer

        class Capturing(orig):
            def __init__(self, *a, **kw):
                super().__init__(*a, **kw)
                server_box["s"] = self

        forward.ThreadingHTTPServer = Capturing
        try:
            t = threading.Thread(target=forward.serve_webhook, args=(received.append, "127.0.0.1", 0, "s3cret"), daemon=True)
            t.start()
            while "s" not in server_box:
                pass
            port = server_box["s"].server_address[1]
            url = f"http://127.0.0.1:{port}/inbound"
            bad = urllib.request.Request(url, data=make_raw(), headers={"X-Inbound-Secret": "nope"})
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(bad)
            self.assertEqual(e.exception.code, 401)
            ok = urllib.request.Request(url, data=make_raw(), headers={"X-Inbound-Secret": "s3cret"})
            self.assertEqual(json.load(urllib.request.urlopen(ok)), {"ok": True})
            self.assertEqual(received[0].subject, "資料をください")
            server_box["s"].shutdown()
        finally:
            forward.ThreadingHTTPServer = orig


class AnalyzerRequestTest(unittest.TestCase):
    def test_request_shape_and_parse(self):
        captured = {}

        def create(**kwargs):
            captured.update(kwargs)
            return SimpleNamespace(
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text=json.dumps(AI_RESULT, ensure_ascii=False))],
            )

        client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
        a = Analyzer(BusinessProfile(company_name="ショップ", signature="ショップ 担当"), client=client)
        result = a.analyze(Inquiry.from_bytes(make_raw(), "t"))
        self.assertEqual(result.customer.company, "山田商事")
        self.assertEqual(captured["model"], "claude-opus-5-5")
        self.assertEqual(captured["output_config"]["format"]["type"], "json_schema")
        self.assertIn("ショップ 担当", captured["system"])

    def test_refusal_raises(self):
        client = SimpleNamespace(
            beta=SimpleNamespace(messages=SimpleNamespace(create=lambda **k: SimpleNamespace(stop_reason="refusal", content=[])))
        )
        with self.assertRaises(RuntimeError):
            Analyzer(BusinessProfile(), client=client).analyze(Inquiry.from_bytes(make_raw(), "t"))


class DraftDirTest(unittest.TestCase):
    def test_directory_sink(self):
        d = Path(tempfile.mkdtemp())
        DirectoryDraftSink(str(d)).save_draft(b"x")
        self.assertEqual(len(list(d.glob("*.eml"))), 1)


if __name__ == "__main__":
    unittest.main()
