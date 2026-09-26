"""Corpus import pipeline V0.

Steps:
  1. scan QCE chunked-jsonl export directories
  2. deterministic sampling (fixed seed, 30k-50k messages)
  3. write read-only raw copies + raw/manifest.json
  4. normalize into normalized/messages.parquet (HMAC anonymized)

No dialog windows, no retrieval, no training artifacts.
"""

from __future__ import annotations

import hashlib
import json
import os
import pathlib
import random
import re
import shutil
import stat
from typing import Any, Iterable

import pyarrow as pa
import pyarrow.parquet as pq

from .adapters import ParseError, clean_text, parse_qce_line
from .anonymize import hash_group_id, hash_mention_id, hash_sender_id
from .config import Config
from .pii import detect_pii

EXPORT_DIR_RE = re.compile(r"^group_(.+?)_\d{8}_\d{6}_chunked_jsonl$")
CHUNK_FILE_RE = re.compile(r"^chunk_\d+\.jsonl$")
BOT_UINS = {"REDACTED_QQ_002", "REDACTED_QQ_005"}


def find_source_exports(sources: Iterable[str]) -> list[pathlib.Path]:
    """Accept either a QCE exports root or individual chunked-jsonl dirs."""
    found: list[pathlib.Path] = []
    for raw in sources:
        p = pathlib.Path(raw)
        if not p.exists():
            raise FileNotFoundError(f"source not found: {p}")
        if (p / "chunks").is_dir() and (p / "manifest.json").is_file():
            found.append(p)
            continue
        # treat as root: discover group_*_chunked_jsonl children
        for child in sorted(p.iterdir()):
            if child.is_dir() and EXPORT_DIR_RE.match(child.name) and (child / "chunks").is_dir():
                found.append(child)
    return sorted(set(found), key=lambda p: str(p))


def scan_candidates(export_dir: pathlib.Path) -> list[tuple[str, int, int]]:
    """Return [(relative_chunk_path, byte_offset, line_no)] for every line."""
    chunks_dir = export_dir / "chunks"
    candidates: list[tuple[str, int, int]] = []
    for chunk in sorted(chunks_dir.iterdir()):
        if not CHUNK_FILE_RE.match(chunk.name):
            continue
        rel = str(chunk.relative_to(export_dir)).replace("\\", "/")
        with chunk.open("r", encoding="utf-8", newline="") as f:
            line_no = 0
            while True:
                offset = f.tell()
                line = f.readline()
                if not line:
                    break
                line_no += 1
                if line.strip():
                    candidates.append((rel, offset, line_no))
    return candidates


def group_id_from_dir(export_dir: pathlib.Path) -> str:
    m = EXPORT_DIR_RE.match(export_dir.name)
    return m.group(1) if m else export_dir.name


def sample_indices(total: int, k: int, seed: int) -> set[int]:
    if total <= k:
        return set(range(total))
    rng = random.Random(seed)
    return set(rng.sample(range(total), k))


def _make_writable(path: pathlib.Path) -> None:
    if path.exists():
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR | stat.S_IRGRP | stat.S_IROTH)


def _reset_output_dirs(cfg: Config) -> None:
    for d in (cfg.raw_dir, cfg.normalized_dir, cfg.reports_dir):
        if d.exists():
            for p in d.rglob("*"):
                if p.is_file():
                    _make_writable(p)
            shutil.rmtree(d)
        d.mkdir(parents=True, exist_ok=True)


def _write_raw_samples(
    export_dir: pathlib.Path,
    candidates: list[tuple[str, int, int]],
    selected: set[int],
    out_file: pathlib.Path,
) -> dict[str, Any]:
    """Write selected lines (original text, original order) to out_file."""
    hits = {idx: cand for idx, cand in enumerate(candidates) if idx in selected}
    by_chunk: dict[str, list[tuple[int, tuple[str, int, int]]]] = {}
    for idx, cand in hits.items():
        by_chunk.setdefault(cand[0], []).append((idx, cand))

    written = 0
    failed_lines: list[dict[str, Any]] = []
    first_ts: int | None = None
    last_ts: int | None = None
    message_count = 0
    type_counts: dict[str, int] = {}
    with out_file.open("w", encoding="utf-8", newline="\n") as out:
        for chunk_rel in sorted(by_chunk):
            chunk_path = export_dir / chunk_rel
            chunk_lines = sorted(by_chunk[chunk_rel], key=lambda x: x[1][2])
            wanted = set(cand[2] for _, cand in chunk_lines)
            with chunk_path.open("r", encoding="utf-8", newline="") as src:
                line_no = 0
                while True:
                    line = src.readline()
                    if not line:
                        break
                    line_no += 1
                    if not line.strip():
                        continue
                    # locate by original line number (offsets can shift with newlines)
                    if line_no in wanted:
                        out.write(line if line.endswith("\n") else line + "\n")
                        written += 1
                        try:
                            rec = parse_qce_line(line)
                            message_count += 1
                            type_counts[rec.message_type] = type_counts.get(rec.message_type, 0) + 1
                            first_ts = rec.timestamp_ms if first_ts is None else min(first_ts, rec.timestamp_ms)
                            last_ts = rec.timestamp_ms if last_ts is None else max(last_ts, rec.timestamp_ms)
                        except ParseError as exc:
                            failed_lines.append(
                                {
                                    "source_file": chunk_rel,
                                    "source_line": line_no,
                                    "error": str(exc),
                                    "preview": line[:160],
                                }
                            )

    return {
        "file": out_file.name,
        "written_lines": written,
        "parsed_messages": message_count,
        "failed_lines": failed_lines,
        "time_start_ms": first_ts,
        "time_end_ms": last_ts,
        "type_counts": type_counts,
    }


def _build_parquet(
    cfg: Config,
    raw_files: list[pathlib.Path],
    group_ids: dict[str, str],
) -> tuple[pa.Table, dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    failed: list[dict[str, Any]] = []
    for raw_file in raw_files:
        group_id = group_ids[raw_file.name]
        group_hash = hash_group_id(cfg.salt, group_id)
        with raw_file.open("r", encoding="utf-8", newline="") as f:
            offset = 0
            for line in f:
                offset += 1
                if not line.strip():
                    continue
                try:
                    rec = parse_qce_line(line)
                except ParseError as exc:
                    failed.append(
                        {
                            "source_file": raw_file.name,
                            "source_offset": offset,
                            "error": str(exc),
                            "preview": line[:160],
                        }
                    )
                    continue

                sender_id = rec.sender_uin or rec.sender_uid
                sender_hash = hash_sender_id(cfg.salt, sender_id)
                mention_hashes = [hash_mention_id(cfg.salt, m) for m in rec.mentions if m]
                media_type = ",".join(rec.media_types) if rec.media_types else "none"
                text_clean = clean_text(rec.text_raw)
                has_pii, pii_types = detect_pii(rec.text_raw)

                rows.append(
                    {
                        "message_id": rec.message_id,
                        "group_id_hash": group_hash,
                        "sender_id_hash": sender_hash,
                        "timestamp": rec.timestamp_ms,
                        "reply_to_id": rec.reply_to_id,
                        "message_type": rec.message_type,
                        "text_raw": rec.text_raw,
                        "text_clean": text_clean,
                        "mentions": mention_hashes,
                        "media_type": media_type,
                        "has_media": len(rec.media_types) > 0,
                        "is_bot": sender_id in BOT_UINS,
                        "is_system": rec.system,
                        "recalled": rec.recalled,
                        "has_pii": has_pii,
                        "pii_types": pii_types,
                        "source_file": raw_file.name,
                        "source_offset": offset,
                    }
                )

    table = pa.table(
        {
            "message_id": pa.array([r["message_id"] for r in rows], type=pa.string()),
            "group_id_hash": pa.array([r["group_id_hash"] for r in rows], type=pa.string()),
            "sender_id_hash": pa.array([r["sender_id_hash"] for r in rows], type=pa.string()),
            "timestamp": pa.array([r["timestamp"] for r in rows], type=pa.int64()),
            "reply_to_id": pa.array([r["reply_to_id"] for r in rows], type=pa.string()),
            "message_type": pa.array([r["message_type"] for r in rows], type=pa.string()),
            "text_raw": pa.array([r["text_raw"] for r in rows], type=pa.string()),
            "text_clean": pa.array([r["text_clean"] for r in rows], type=pa.string()),
            "mentions": pa.array([r["mentions"] for r in rows], type=pa.list_(pa.string())),
            "media_type": pa.array([r["media_type"] for r in rows], type=pa.string()),
            "has_media": pa.array([r["has_media"] for r in rows], type=pa.bool_()),
            "is_bot": pa.array([r["is_bot"] for r in rows], type=pa.bool_()),
            "is_system": pa.array([r["is_system"] for r in rows], type=pa.bool_()),
            "recalled": pa.array([r["recalled"] for r in rows], type=pa.bool_()),
            "has_pii": pa.array([r["has_pii"] for r in rows], type=pa.bool_()),
            "pii_types": pa.array([r["pii_types"] for r in rows], type=pa.list_(pa.string())),
            "source_file": pa.array([r["source_file"] for r in rows], type=pa.string()),
            "source_offset": pa.array([r["source_offset"] for r in rows], type=pa.int64()),
        }
    )
    return table, {"failed": failed, "row_count": len(rows)}


def _sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def run_pipeline(cfg: Config) -> dict[str, Any]:
    exports = find_source_exports(cfg.sources)
    _reset_output_dirs(cfg)

    raw_manifest_files: list[dict[str, Any]] = []
    raw_files: list[pathlib.Path] = []
    group_ids: dict[str, str] = {}
    all_scan: list[tuple[pathlib.Path, list[tuple[str, int, int]]]] = []

    for export_dir in exports:
        candidates = scan_candidates(export_dir)
        all_scan.append((export_dir, candidates))

    total = sum(len(c) for _, c in all_scan)
    k = min(cfg.sample_size, total)
    selected = sample_indices(total, k, cfg.seed)

    cursor = 0
    per_file_summary: list[dict[str, Any]] = []
    for export_dir, candidates in all_scan:
        local_selected = set()
        for i in range(len(candidates)):
            if cursor + i in selected:
                local_selected.add(i)
        cursor += len(candidates)
        if not local_selected:
            continue

        group_id = group_id_from_dir(export_dir)
        group_hash = hash_group_id(cfg.salt, group_id)
        out_file = cfg.raw_dir / f"sample_{group_hash[:12]}.jsonl"
        summary = _write_raw_samples(export_dir, candidates, local_selected, out_file)
        raw_files.append(out_file)
        group_ids[out_file.name] = group_id
        per_file_summary.append(
            {
                "group_id": group_id,
                "source_export": export_dir.name,
                "sample_file": out_file.name,
                "sample_messages": summary["parsed_messages"],
                "failed_in_sample": summary["failed_lines"],
            }
        )

    # raw manifest
    for raw_file in raw_files:
        sha = _sha256(raw_file)
        with raw_file.open("r", encoding="utf-8") as f:
            line_count = sum(1 for _ in f)
        raw_manifest_files.append(
            {
                "file": raw_file.name,
                "format": "qce-chunked-jsonl",
                "sha256": sha,
                "sizeBytes": raw_file.stat().st_size,
                "messageCount": line_count,
                "groupId": group_ids[raw_file.name],
            }
        )

    # read-only raw files
    for raw_file in raw_files:
        os.chmod(raw_file, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)

    raw_manifest = {
        "generatedAt": None,  # filled by report step (deterministic content only)
        "seed": cfg.seed,
        "sampleSize": k,
        "files": raw_manifest_files,
    }
    (cfg.raw_dir / "manifest.json").write_text(json.dumps(raw_manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    table, norm_info = _build_parquet(cfg, raw_files, group_ids)
    pq.write_table(table, cfg.normalized_dir / "messages.parquet")

    return {
        "selected": k,
        "scanned": total,
        "per_file": per_file_summary,
        "parquet_rows": norm_info["row_count"],
        "parse_failures": norm_info["failed"],
        "raw_files": [f.name for f in raw_files],
    }
