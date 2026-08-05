"""End-to-end tests for corpus import V0."""

from __future__ import annotations

import os
import pathlib
import shutil
import stat
import tempfile
import unittest

import pyarrow.parquet as pq

from community_corpus.adapters import clean_text, parse_qce_line
from community_corpus.anonymize import hash_group_id, hash_mention_id, hash_sender_id
from community_corpus.config import Config
from community_corpus.pipeline import run_pipeline
from community_corpus.report import build_report

FIXTURES = pathlib.Path(__file__).parent / "fixtures"
FIXTURE_EXPORT = FIXTURES / "group_test_123_20260805_000000_chunked_jsonl"


def make_config(tmp: pathlib.Path, salt: str = "test-salt-0001") -> Config:
    return Config(
        sources=(str(FIXTURE_EXPORT),),
        sample_size=50_000,
        seed=20260805,
        salt=salt,
        output_dir=tmp,
    )


def read_rows(tmp: pathlib.Path):
    table = pq.read_table(tmp / "normalized" / "messages.parquet")
    return table.to_pylist()


class CorpusPipelineTest(unittest.TestCase):
    def setUp(self):
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="community-corpus-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_hmac_stable_and_no_raw_ids(self):
        cfg = make_config(self.tmp)
        run_pipeline(cfg)
        rows = read_rows(self.tmp)
        self.assertEqual(len(rows), 14)  # all non-empty raw lines are preserved

        # same salt => same hashes
        expected_group = hash_group_id(cfg.salt, "test_123")
        expected_sender = hash_sender_id(cfg.salt, "1111111111")
        self.assertTrue(all(r["group_id_hash"] == expected_group for r in rows))
        self.assertTrue(any(r["sender_id_hash"] == expected_sender for r in rows))

        # different salt => different hash (anonymization is keyed)
        cfg2 = make_config(self.tmp, salt="other-salt-9999")
        run_pipeline(cfg2)
        rows2 = read_rows(self.tmp)
        self.assertNotEqual(rows[0]["sender_id_hash"], rows2[0]["sender_id_hash"])

        # no raw identifiers in normalized output
        serialized = "\n".join(
            f"{r['sender_id_hash']}|{r['group_id_hash']}|{r['mentions']}|{r['source_file']}" for r in rows
        )
        for secret in ("1111111111", "2222222222", "3333333333", "u_player_a", "test_123", "REDACTED_QQ_002"):
            self.assertNotIn(secret, serialized)

    def test_timestamp_correct(self):
        run_pipeline(make_config(self.tmp))
        rows = read_rows(self.tmp)
        by_id = {r["message_id"]: r for r in rows}
        self.assertEqual(by_id["1001"]["timestamp"], 1785400000000)
        self.assertEqual(by_id["1009"]["timestamp"], 1785400480000)

    def test_reply_to_bound(self):
        run_pipeline(make_config(self.tmp))
        rows = read_rows(self.tmp)
        by_id = {r["message_id"]: r for r in rows}
        self.assertEqual(by_id["1003"]["message_type"], "reply")
        self.assertEqual(by_id["1003"]["reply_to_id"], "1002")

    def test_unknown_not_dropped(self):
        run_pipeline(make_config(self.tmp))
        rows = read_rows(self.tmp)
        unknown = {r["message_id"] for r in rows if r["message_type"] == "unknown"}
        # type_99 (unrecognized) and type_17 (market face without defined semantics)
        self.assertIn("1008", unknown)
        self.assertIn("1007", unknown)

    def test_counts_match_source(self):
        cfg = make_config(self.tmp)
        result = run_pipeline(cfg)
        raw_files = [p for p in (self.tmp / "raw").iterdir() if p.suffix == ".jsonl" and p.name != "manifest.json"]
        self.assertEqual(len(raw_files), 1)
        raw_file = raw_files[0]
        with raw_file.open("r", encoding="utf-8") as f:
            raw_lines = sum(1 for _ in f if _.strip())
        rows = read_rows(self.tmp)
        self.assertEqual(raw_lines, len(rows))
        self.assertEqual(raw_lines, result["parquet_rows"])
        # all rows can be located back through source_file/source_offset
        raw_text = raw_file.read_text(encoding="utf-8").splitlines()
        for r in rows:
            line = raw_text[r["source_offset"] - 1]
            self.assertIn(r["message_id"], line)

    def test_media_and_clean_text(self):
        run_pipeline(make_config(self.tmp))
        rows = read_rows(self.tmp)
        by_id = {r["message_id"]: r for r in rows}
        self.assertTrue(by_id["1002"]["has_media"])
        self.assertEqual(by_id["1002"]["media_type"], "image")
        self.assertEqual(by_id["1002"]["text_clean"], "")
        self.assertEqual(by_id["1012"]["media_type"], "image")
        self.assertEqual(by_id["1012"]["text_clean"], "看看这 acc")
        self.assertEqual(by_id["1003"]["text_clean"], "确实")

    def test_flags_and_pii(self):
        run_pipeline(make_config(self.tmp))
        rows = read_rows(self.tmp)
        by_id = {r["message_id"]: r for r in rows}
        self.assertTrue(by_id["1004"]["has_pii"])
        self.assertIn("qq", by_id["1004"]["pii_types"])
        self.assertTrue(by_id["1011"]["is_bot"])
        self.assertTrue(by_id["1009"]["is_system"])
        self.assertTrue(by_id["1014"]["recalled"])
        self.assertEqual(by_id["1003"]["mentions"], [hash_mention_id("test-salt-0001", "2222222222")])

    def test_raw_manifest_and_readonly(self):
        run_pipeline(make_config(self.tmp))
        manifest = self.tmp / "raw" / "manifest.json"
        self.assertTrue(manifest.exists())
        import json

        data = json.loads(manifest.read_text(encoding="utf-8"))
        self.assertEqual(len(data["files"]), 1)
        self.assertEqual(data["files"][0]["messageCount"], 14)
        self.assertEqual(data["files"][0]["format"], "qce-chunked-jsonl")
        raw_files = [p for p in (self.tmp / "raw").iterdir() if p.suffix == ".jsonl" and p.name != "manifest.json"]
        raw_file = raw_files[0]
        mode = os.stat(raw_file).st_mode
        self.assertEqual(mode & stat.S_IWRITE, 0)

    def test_report_structure(self):
        cfg = make_config(self.tmp)
        result = run_pipeline(cfg)
        report = build_report(cfg, result)
        self.assertEqual(report["summary"]["totalMessages"], 14)
        self.assertIn("unknownTypes", report["summary"])
        self.assertIn("typeDistribution", report)
        self.assertIn("perFile", report)
        self.assertIn("replyReference", report)
        self.assertEqual(report["replyReference"]["resolved"], 1)
        self.assertEqual(report["replyReference"]["linkedInBatch"], 1)


class AdapterUnitTest(unittest.TestCase):
    def test_clean_text(self):
        self.assertEqual(clean_text("[回复消息]@玩家乙 确实"), "确实")
        self.assertEqual(clean_text("@玩家乙 打图吗"), "打图吗")
        self.assertEqual(clean_text("[图片:bp.jpg] 看看这 acc"), "看看这 acc")
        self.assertEqual(clean_text("[图片:bp.jpg]"), "")

    def test_parse_unknown(self):
        line = '{"id":"x","seq":"1","timestamp":1785400000000,"sender":{"uid":"u_a","uin":"1","name":"a"},"type":"type_77","content":{"text":"hi","elements":[],"resources":[],"mentions":[]},"recalled":false,"system":false}'
        rec = parse_qce_line(line)
        self.assertEqual(rec.message_type, "unknown")


if __name__ == "__main__":
    unittest.main()
