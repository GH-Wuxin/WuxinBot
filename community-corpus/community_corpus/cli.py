"""CLI for the community corpus pipeline."""

from __future__ import annotations

import argparse
import pathlib
import sys

from . import __version__
from .config import build_config
from .pipeline import run_pipeline
from .report import build_report, write_report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="community-corpus",
        description="osu! community corpus import pipeline V0",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--sources",
        required=True,
        help="comma separated QCE export dirs, or one exports root dir",
    )
    parser.add_argument("--sample-size", type=int, default=50_000, help="messages to sample (30000-50000)")
    parser.add_argument("--seed", type=int, default=20260805, help="fixed sampling seed")
    parser.add_argument("--out-dir", type=pathlib.Path, default=None, help="output root (default: package root)")
    parser.add_argument("--salt-file", type=pathlib.Path, default=None, help="HMAC salt file (auto-created if missing)")
    args = parser.parse_args(argv)

    cfg = build_config(
        sources=[s.strip() for s in args.sources.split(",") if s.strip()],
        sample_size=args.sample_size,
        seed=args.seed,
        output_dir=args.out_dir,
        salt_file=args.salt_file,
    )

    print(f"[community-corpus] scanning {len(cfg.sources)} source(s), sampling {cfg.sample_size} messages (seed={cfg.seed})")
    result = run_pipeline(cfg)
    print(
        f"[community-corpus] scanned {result['scanned']} lines, selected {result['selected']}, "
        f"parquet rows {result['parquet_rows']}, parse failures {len(result['parse_failures'])}"
    )
    report = build_report(cfg, result)
    write_report(cfg, report)
    print(f"[community-corpus] report: {cfg.reports_dir / 'import-report.json'}")
    print(f"[community-corpus] parquet: {cfg.normalized_dir / 'messages.parquet'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
