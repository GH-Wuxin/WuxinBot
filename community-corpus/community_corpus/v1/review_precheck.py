"""Automatic pre-check for the V1 manual-review sample.

Checks the acceptance gates that can be verified deterministically before
human review:

1. sample size / dataset pool (community only);
2. pure bot/system/spam candidates <= 5%;
3. high-risk privacy leaks == 0 (full corpus optional via --full);
4. highly overlapping sample windows == 0;
5. media-dependent windows without text anchor == 0.

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
    _INVITE_PARAM_RE,
    _INVITE_RE,
    _IP_RE,
    _LOCATION_RE,
    _MENTION_RE,
    _PHONE_RE,
    _PROFILE_FIELD_RE,
    _QQ_CONTEXT_RE,
    _QQ_GROUP_RE,
    _looks_like_person_name,
)
from .windows import _has_sufficient_anchor, _is_spam


PII_SCANNERS = [
    ("phone", _PHONE_RE),
    ("email", _EMAIL_RE),
    ("ip", _IP_RE),
    ("invite_url", _INVITE_RE),
    ("invite_param", _INVITE_PARAM_RE),
    ("qq_context", _QQ_CONTEXT_RE),
    ("qq_group", _QQ_GROUP_RE),
    ("id_card", _ID_CARD_RE),
    ("credential", _CREDENTIAL_RE),
    ("credential_url", _CREDENTIAL_URL_RE),
    ("profile_field", _PROFILE_FIELD_RE),
    ("card", _CARD_RE),
    ("raw_mention", _MENTION_RE),
    ("location", _LOCATION_RE),
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
            "dataset",
            "message_ids",
            "media_dependent",
            "human_message_count",
            "bot_message_count",
            "bot_output_count",
            "privacy_risk",
            "text_sanitized",
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

    annotated: dict[str, list[dict]] = {}
    if annotated_path is not None and annotated_path.exists():
        with annotated_path.open("r", encoding="utf-8") as f:
            for line in f:
                rec = json.loads(line)
                annotated[rec["window_id"]] = rec.get("annotated_lines", [])

    problems: dict[str, list[str]] = {
        "non_community": [],
        "bot_or_spam": [],
        "privacy": [],
        "overlap": [],
        "media_no_anchor": [],
    }
    pii_hits: collections.Counter[str] = collections.Counter()

    for w in sample:
        wid = w["window_id"]
        full = windows.get(wid, {})
        dataset = full.get("dataset", w.get("dataset", ""))
        if dataset != "community" and full.get("privacy_risk") != "high":
            problems["non_community"].append(wid)

        bot_lines = sum(1 for l in annotated.get(wid, []) if l.get("role") == "bot")
        system_lines = sum(1 for l in annotated.get(wid, []) if l.get("role") == "system")
        msgs = [messages[m] for m in (full.get("message_ids") or []) if m in messages]
        spam = bool(msgs) and _is_spam(msgs)
        if dataset == "community" and (bot_lines > 0 or system_lines > 0 or spam):
            problems["bot_or_spam"].append(wid)

        text = w.get("text_sanitized") or ""
        hits = _scan_pii(text)
        if hits:
            problems["privacy"].append(wid)
            for h in hits:
                pii_hits[h] += 1

        if full.get("media_dependent"):
            if not msgs or not _has_sufficient_anchor(msgs):
                problems["media_no_anchor"].append(wid)

    # near-duplicate pairs inside the sample (Jaccard >= 0.8)
    ids = [(w["window_id"], set(w.get("message_ids", []))) for w in sample]
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            union = len(ids[i][1] | ids[j][1])
            if union and len(ids[i][1] & ids[j][1]) / union >= 0.8:
                problems["overlap"].append(f"{ids[i][0]}+{ids[j][0]}")

    # optional full-corpus PII scan
    full_pii: dict[str, int] = {}
    if full_scan:
        all_text = pq.read_table(windows_path, columns=["text_sanitized"]).column("text_sanitized").to_pylist()
        for text in all_text:
            for h in _scan_pii(text or ""):
                full_pii[h] = full_pii.get(h, 0) + 1

    sample_size = len(sample)
    community_count = sum(
        1
        for w in sample
        if windows.get(w["window_id"], {}).get("dataset", w.get("dataset", "")) == "community"
    )
    bot_or_spam_ratio = (
        round(len(problems["bot_or_spam"]) / community_count, 4) if community_count else 0
    )
    passed = (
        sample_size == 300
        and not problems["non_community"]
        and bot_or_spam_ratio <= 0.05
        and not problems["privacy"]
        and not problems["overlap"]
        and not problems["media_no_anchor"]
        and (not full_scan or not full_pii)
    )
    result = {
        "sampleSize": sample_size,
        "passed": passed,
        "gates": {
            "nonCommunityOnlyHighRisk": not problems["non_community"],
            "botSystemSpamRatio": bot_or_spam_ratio,
            "botSystemSpamRatioLimit": 0.05,
            "privacyLeakCount": len(problems["privacy"]),
            "overlapPairs": len(problems["overlap"]),
            "mediaWithoutAnchor": len(problems["media_no_anchor"]),
        },
        "problemWindows": problems,
        "samplePiiTypes": dict(pii_hits),
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
