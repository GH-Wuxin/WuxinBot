"""Automatic pre-check for the V1 manual-review sample.

Acceptance is privacy-first: the only veto is raw PII leaking into any
production candidate, review sheet, log or export. Window "quality" is
informational only (tiers, bot share, media anchor) and no longer gates the
pipeline.

Deterministic gates:
1. sample size == 300;
2. zero PII hits in the sample sanitized text and in annotated exports;
3. every sample window carries a valid ``usage_tier`` and ``overlap_cluster_id``;
4. no two non-high-risk sample windows share an overlap cluster (retrieval
   pollution control for the review round; the full corpus keeps clusters);
5. every sample window remains traceable via ``source_refs``;
6. optional full-corpus PII scan must be clean (--full).

Output: reports/manual-review-v1-precheck.json
"""

from __future__ import annotations

import argparse
import collections
import json
import pathlib
import re
import sys
from typing import Any

import pyarrow.parquet as pq

from .sanitize import (
    _CARD_RE,
    _CREDENTIAL_RE,
    _CREDENTIAL_URL_RE,
    _EMAIL_RE,
    _ID_CARD_RE,
    _UNIQUE_PARAM_RE,
    _INVITE_RE,
    _IP_RE,
    _LOCATION_RE,
    _MENTION_RE,
    _PHONE_RE,
    _PROFILE_FIELD_RE,
    _QQ_CONTEXT_RE,
    _QQ_GROUP_RE,
    _REAL_NAME_RE,
    _looks_like_person_name,
)
from .windows import USAGE_TIERS, _has_sufficient_anchor, _is_spam


PII_SCANNERS = [
    ("phone", _PHONE_RE),
    ("email", _EMAIL_RE),
    ("ip", _IP_RE),
    ("invite_url", _INVITE_RE),
    ("invite_param", _UNIQUE_PARAM_RE),
    ("qq_context", _QQ_CONTEXT_RE),
    ("qq_group", _QQ_GROUP_RE),
    ("id_card", _ID_CARD_RE),
    ("credential", _CREDENTIAL_RE),
    ("credential_url", _CREDENTIAL_URL_RE),
    ("profile_field", _PROFILE_FIELD_RE),
    ("card", _CARD_RE),
    ("raw_mention", _MENTION_RE),
    ("location", _LOCATION_RE),
    ("real_name", _REAL_NAME_RE),
]

_EXTRA_PII_RE = re.compile(
    r"(?i)(?:token|password|passwd|secret|api[_-]?key|bearer)\s*[=:]\s*[A-Za-z0-9._%+/-]{12,}"
    r"|\b(?:discord|website|occupation|bilibili)\s*[:：]\s*\S{4,}"
)

_FORWARD_BLOCK_RE = re.compile(r"\[(?:转发消息|Forwarded Messages)\s*[:：]\s*\d+\s*条?\]")
_FORWARD_NAME_LEAK_RE = re.compile(
    r"(?m)^(\s{1,8})([A-Za-z0-9_\u4e00-\u9fa5·｜|\- ]{1,40}): "
)


def _scan_pii(text: str) -> set[str]:
    hits: set[str] = set()
    for name, rx in PII_SCANNERS:
        if rx.search(text):
            hits.add(name)
    if _EXTRA_PII_RE.search(text):
        hits.add("credential_extra")
    if _forward_has_raw_name(text):
        hits.add("forward_name_leak")
    return hits


def _forward_has_raw_name(text: str) -> bool:
    """Raw sender names still present inside a forwarded-message block."""
    lines = text.split("\n")
    in_block = False
    for line in lines:
        if _FORWARD_BLOCK_RE.search(line):
            in_block = True
            continue
        if not in_block:
            continue
        m = _FORWARD_NAME_LEAK_RE.match(line)
        if not m:
            continue
        name = m.group(2).strip()
        if name == "<NICK>" or not _looks_like_person_name(name):
            continue
        return True
    return False


def run_precheck(
    review_path: pathlib.Path,
    windows_path: pathlib.Path,
    annotated_path: pathlib.Path | None,
    messages_path: pathlib.Path | None,
    full_scan: bool,
) -> dict[str, Any]:
    with review_path.open("r", encoding="utf-8") as f:
        sample = [json.loads(line) for line in f]
    win_table = pq.read_table(
        windows_path,
        columns=[
            "window_id",
            "usage_tier",
            "overlap_cluster_id",
            "overlap_cluster_representative",
            "message_ids",
            "media_dependent",
            "human_message_count",
            "bot_message_count",
            "bot_output_count",
            "privacy_risk",
            "text_sanitized",
            "source_refs",
        ],
    )
    windows = {w["window_id"]: w for w in win_table.to_pylist()}
    message_rows = (
        pq.read_table(
            messages_path,
            columns=[
                "message_id",
                "message_type",
                "text_clean",
                "has_media",
                "is_bot",
                "is_system",
                "bot_output_like",
            ],
        ).to_pylist()
        if messages_path is not None
        else []
    )
    messages = {r["message_id"]: r for r in message_rows}

    annotated: dict[str, dict] = {}
    if annotated_path is not None and annotated_path.exists():
        with annotated_path.open("r", encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                annotated[rec["window_id"]] = rec

    problems: dict[str, list[str]] = {
        "privacy": [],
        "annotated_privacy": [],
        "usage_tier_missing": [],
        "overlap_cluster_missing": [],
        "cluster_dupes": [],
        "missing_source_refs": [],
    }
    pii_hits: collections.Counter[str] = collections.Counter()
    annotated_pii_hits: collections.Counter[str] = collections.Counter()
    tier_dist: collections.Counter[str] = collections.Counter()
    bot_or_spam_count = 0
    media_no_anchor_count = 0
    cluster_members: dict[str, list[tuple[str, str]]] = collections.defaultdict(list)

    for w in sample:
        wid = w["window_id"]
        full = windows.get(wid, {})
        tier = full.get("usage_tier", w.get("usage_tier", ""))
        if tier not in USAGE_TIERS:
            problems["usage_tier_missing"].append(wid)
        else:
            tier_dist[tier] += 1

        cluster_id = full.get("overlap_cluster_id") or w.get("overlap_cluster_id")
        if not cluster_id:
            problems["overlap_cluster_missing"].append(wid)
        risk = full.get("privacy_risk", w.get("privacy_risk", "low"))
        if cluster_id:
            cluster_members[cluster_id].append((wid, risk))

        refs = full.get("source_refs") or w.get("source_refs")
        if not refs:
            problems["missing_source_refs"].append(wid)

        annotated_rec = annotated.get(wid, {})
        annotated_lines = annotated_rec.get("annotated_lines", [])
        bot_lines = sum(1 for l in annotated_lines if l.get("role") == "bot")
        system_lines = sum(1 for l in annotated_lines if l.get("role") == "system")
        msgs = [messages[m] for m in (full.get("message_ids") or []) if m in messages]
        spam = bool(msgs) and _is_spam(msgs)
        if tier in (
            "style_ready",
            "contextual_style",
            "ambient_chat",
        ) and (bot_lines > 0 or system_lines > 0 or spam):
            bot_or_spam_count += 1

        text = w.get("text_sanitized") or ""
        hits = _scan_pii(text)
        if hits:
            problems["privacy"].append(wid)
            for h in hits:
                pii_hits[h] += 1

        annotated_texts = [annotated_rec.get("annotated_text", "")]
        annotated_texts += [line.get("text", "") for line in annotated_lines]
        for ltext in annotated_texts:
            lhits = _scan_pii(ltext or "")
            if lhits:
                problems["annotated_privacy"].append(wid)
                for h in lhits:
                    annotated_pii_hits[h] += 1

        if full.get("media_dependent"):
            if not msgs or not _has_sufficient_anchor(msgs):
                media_no_anchor_count += 1

    # retrieval-pollution gate for the review round: no two non-high-risk
    # sample windows may share an overlap cluster. High-risk windows are all
    # audited for privacy and may legitimately repeat a cluster.
    for cid, members in cluster_members.items():
        non_high = [wid for wid, risk in members if risk != "high"]
        if len(non_high) > 1:
            problems["cluster_dupes"].append(cid)

    # optional full-corpus PII scan
    full_pii: dict[str, int] = {}
    if full_scan:
        all_text = pq.read_table(windows_path, columns=["text_sanitized"]).column("text_sanitized").to_pylist()
        for text in all_text:
            for h in _scan_pii(text or ""):
                full_pii[h] = full_pii.get(h, 0) + 1

    sample_size = len(sample)
    non_private_count = sum(
        1
        for w in sample
        if windows.get(w["window_id"], {}).get("usage_tier", w.get("usage_tier", ""))
        in ("style_ready", "contextual_style", "ambient_chat", "bot_interaction")
    )
    bot_or_spam_ratio = (
        round(bot_or_spam_count / non_private_count, 4) if non_private_count else 0
    )
    passed = (
        sample_size == 300
        and not problems["privacy"]
        and not problems["annotated_privacy"]
        and not problems["usage_tier_missing"]
        and not problems["overlap_cluster_missing"]
        and not problems["cluster_dupes"]
        and not problems["missing_source_refs"]
        and (not full_scan or not full_pii)
    )
    result = {
        "sampleSize": sample_size,
        "passed": passed,
        "gates": {
            "privacyLeakCount": len(problems["privacy"]),
            "annotatedLeakCount": len(problems["annotated_privacy"]),
            "usageTierMissing": len(problems["usage_tier_missing"]),
            "overlapClusterMissing": len(problems["overlap_cluster_missing"]),
            "sampleClusterDupes": len(problems["cluster_dupes"]),
            "missingSourceRefs": len(problems["missing_source_refs"]),
            "fullCorpusPiiHitTypes": len(full_pii),
        },
        "informational": {
            "tierDistribution": dict(tier_dist),
            "botSystemSpamRatio": bot_or_spam_ratio,
            "mediaWithoutAnchorCount": media_no_anchor_count,
            "overlapClusterPairsIncludingHighRisk": sum(
                1 for members in cluster_members.values() if len(members) > 1
            ),
        },
        "problemWindows": problems,
        "samplePiiTypes": dict(pii_hits),
        "annotatedPiiTypes": dict(annotated_pii_hits),
        "fullCorpusPiiHits": full_pii,
    }
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="community-corpus-review-precheck")
    parser.add_argument(
        "--review",
        type=pathlib.Path,
        default=pathlib.Path("reports/manual-review-v1.jsonl"),
    )
    parser.add_argument(
        "--windows",
        type=pathlib.Path,
        default=pathlib.Path("windows/v1/windows.parquet"),
    )
    parser.add_argument(
        "--annotated",
        type=pathlib.Path,
        default=pathlib.Path("reports/manual-review-v1-annotated.jsonl"),
    )
    parser.add_argument("--full", action="store_true", help="scan every window for PII")
    parser.add_argument(
        "--messages",
        type=pathlib.Path,
        default=pathlib.Path("normalized/full/messages.parquet"),
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        default=pathlib.Path("reports/manual-review-v1-precheck.json"),
    )
    args = parser.parse_args(argv)
    result = run_precheck(args.review, args.windows, args.annotated, args.messages, args.full)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result["gates"], ensure_ascii=False, indent=2))
    print(f"[review-precheck] passed={result['passed']} -> {args.output}")
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
