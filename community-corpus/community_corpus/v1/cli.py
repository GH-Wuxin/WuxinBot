"""V1 CLI: run full import -> sessions -> windows -> sanitize -> splits -> report."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

import pyarrow.parquet as pq

from ..config import build_config
from .full_import import find_source_exports, run_full_import
from .reader import load_sender_names
from .report_v1 import build_v1_report, write_manual_review, write_v1_report
from .review_precheck import run_precheck
from .sessions import build_sessions, threshold_stats, write_sessions
from .splits import apply_splits, session_splits
from .windows import build_windows, finalize_window_texts, write_windows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="community-corpus-v1", description="osu! community corpus V1 pipeline")
    parser.add_argument(
        "--sources",
        required=True,
        help="comma separated QCE export dirs, or one exports root dir",
    )
    parser.add_argument("--seed", type=int, default=20260805, help="deterministic seed")
    parser.add_argument(
        "--review-seed",
        type=int,
        default=20260806,
        help="deterministic seed for the 300-window manual review sample (new seed per round)",
    )
    parser.add_argument("--out-dir", type=pathlib.Path, default=None, help="output root (default: package root)")
    parser.add_argument("--salt-file", type=pathlib.Path, default=None, help="HMAC salt file (reuses V0 .salt)")
    parser.add_argument("--gap-minutes", type=int, default=8, help="session gap threshold in minutes")
    args = parser.parse_args(argv)

    cfg = build_config(
        sources=[s.strip() for s in args.sources.split(",") if s.strip()],
        sample_size=50_000,  # required by config validator; unused by V1 full import
        seed=args.seed,
        output_dir=args.out_dir,
        salt_file=args.salt_file,
    )
    gap_minutes = args.gap_minutes

    print("[v1] 1/6 full import (all messages, V0 frozen)")
    full_result = run_full_import(cfg)
    print(
        f"[v1] imported {full_result['totalMessages']} messages from {len(full_result['perSource'])} groups, "
        f"failures {len(full_result['parseFailures'])}"
    )

    print("[v1] 2/6 session construction")
    messages = pq.read_table(cfg.normalized_dir / "full" / "messages.parquet").to_pylist()
    sessions = build_sessions(messages, gap_minutes=gap_minutes)
    stats = threshold_stats(messages, thresholds=(3, 5, 8, 15))
    session_result = write_sessions(cfg, sessions, stats)
    print(f"[v1] sessions: {len(sessions)} (gap={gap_minutes}min)")
    del messages

    print("[v1] 3/6 window construction")
    table = pq.read_table(cfg.normalized_dir / "full" / "messages.parquet")
    windows, filter_stats = build_windows(table, sessions)
    print(f"[v1] windows built: {len(windows)}")

    print("[v1] 4/6 text sanitization")
    export_dirs = find_source_exports(cfg.sources)
    refs = set()
    for w in windows:
        for m in w["_messages"]:
            refs.add((m["source_export"], m["source_file"], m["source_offset_bytes"]))
    sender_names = load_sender_names(export_dirs, refs)
    finalize_window_texts(windows, sender_names)

    print("[v1] 5/6 deterministic splits")
    splits = session_splits(sessions, args.seed)
    apply_splits(windows, splits)

    print("[v1] 6/6 reports + manual review")
    window_path = write_windows(cfg, windows)
    report = build_v1_report(cfg, full_result, session_result, windows, filter_stats, args.seed)
    write_v1_report(cfg, report)
    sample = write_manual_review(cfg, windows, args.review_seed)
    precheck = run_precheck(
        cfg.reports_dir / "manual-review-v1.jsonl",
        cfg.output_dir / "windows" / "v1" / "windows.parquet",
        None,
        cfg.normalized_dir / "full" / "messages.parquet",
        full_scan=False,
    )
    (cfg.reports_dir / "manual-review-v1-precheck.json").write_text(
        json.dumps(precheck, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[v1] windows.parquet: {window_path}")
    print(f"[v1] report: {cfg.reports_dir / 'window-report-v1.json'}")
    print(
        f"[v1] manual review (seed={args.review_seed}): "
        f"{cfg.reports_dir / 'manual-review-v1.jsonl'} ({len(sample)} rows)"
    )
    print(f"[v1] precheck passed={precheck['passed']}")
    print(f"[v1] done")
    return 0


if __name__ == "__main__":
    sys.exit(main())
