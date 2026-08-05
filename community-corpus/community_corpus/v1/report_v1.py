"""Task 6: V1 window report + fixed-seed manual review sample."""

from __future__ import annotations

import collections
import json
import pathlib
import random
from typing import Any

import pyarrow.parquet as pq

from .sessions import _percentile
from .splits import TRAIN, REVIEW, EVAL
from .windows import (
    DATASET_COMMUNITY,
    DATASET_BOT_OPERATION,
    DATASET_MEDIA_REACTION,
    DATASET_REJECTED_CANDIDATE,
    TYPE_REPLY_CHAIN,
    TYPE_TEMPORAL_BURST,
    TYPE_MEDIA_BOT,
)


def _approx_duplicates(windows: list[dict[str, Any]]) -> int:
    """Count near-duplicate window pairs (Jaccard >= 0.8) within a session."""
    by_session: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for w in windows:
        by_session[w["session_id"]].append(w)
    pairs = 0
    for session_windows in by_session.values():
        ids = [set(w["message_ids"]) for w in session_windows]
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                union = len(ids[i] | ids[j])
                if union == 0:
                    continue
                if len(ids[i] & ids[j]) / union >= 0.8:
                    pairs += 1
    return pairs


def _message_gap_stats(messages_path: pathlib.Path) -> dict[str, Any]:
    """Measure reply-target availability and unique message count."""
    t = pq.read_table(messages_path, columns=["message_id", "reply_to_id"])
    rows = t.to_pylist()
    mids = {r["message_id"] for r in rows}
    reply_total = 0
    found = 0
    for r in rows:
        ref = r["reply_to_id"]
        if ref:
            reply_total += 1
            if ref in mids:
                found += 1
    return {
        "totalMessages": len(rows),
        "uniqueMessages": len(mids),
        "replyMessages": reply_total,
        "replyTargetsInCorpus": found,
        "replyTargetsMissing": reply_total - found,
    }


def build_v1_report(
    cfg,
    full_result: dict[str, Any],
    session_result: dict[str, Any],
    windows: list[dict[str, Any]],
    filter_stats: dict[str, int],
    seed: int,
) -> dict[str, Any]:
    total = len(windows)
    type_dist = collections.Counter(w["window_type"] for w in windows)
    dataset_dist = collections.Counter(w["dataset"] for w in windows)
    risk_dist = collections.Counter(w["privacy_risk"] for w in windows)
    split_dist = collections.Counter(w["split"] for w in windows)
    group_dist = collections.Counter(w["group_id_hash"] for w in windows)
    month_dist: collections.Counter[str] = collections.Counter()
    member_dist: collections.Counter[str] = collections.Counter()
    for w in windows:
        ts = w["start_timestamp"]
        import datetime

        month_dist[datetime.datetime.fromtimestamp(ts / 1000, tz=datetime.timezone.utc).strftime("%Y-%m")] += 1
        for sid in w["speaker_ids"]:
            member_dist[sid] += 1

    msg_counts = [w["human_message_count"] + w["bot_message_count"] for w in windows]
    char_counts = [w["char_count"] for w in windows]
    reply_depths = [w["reply_depth"] for w in windows if w["window_type"] == "reply_chain"]
    media_dependent = sum(1 for w in windows if w["media_dependent"])
    bot_output_windows = [w for w in windows if w["bot_output_count"] > 0]
    bot_output_by_type = collections.Counter(w["window_type"] for w in bot_output_windows)
    duplicate_exact = 0  # construction already dedupes identical message_ids
    duplicate_approx_removed = filter_stats.get("near_duplicate_removed", 0)
    duplicate_approx_remaining = _approx_duplicates(windows)
    gap_stats = _message_gap_stats(cfg.normalized_dir / "full" / "messages.parquet")
    covered_messages: set[str] = set()
    for w in windows:
        covered_messages.update(w["message_ids"])

    member_total = sum(member_dist.values())
    top_members = member_dist.most_common(10)
    top1_ratio = top_members[0][1] / member_total if member_total and top_members else 0
    top10_ratio = sum(c for _, c in top_members) / member_total if member_total else 0

    return {
        "schemaVersion": "v1",
        "seed": seed,
        "summary": {
            "sessionCount": session_result["sessionCount"],
            "windowCount": total,
            "windowCountBeforeDedup": filter_stats.get("windows_before_dedup", total),
            "windowCountRemovedByDedup": filter_stats.get("near_duplicate_removed", 0),
            "windowTypeDistribution": {
                TYPE_REPLY_CHAIN: type_dist.get(TYPE_REPLY_CHAIN, 0),
                TYPE_TEMPORAL_BURST: type_dist.get(TYPE_TEMPORAL_BURST, 0),
                TYPE_MEDIA_BOT: type_dist.get(TYPE_MEDIA_BOT, 0),
            },
            "datasetDistribution": {
                DATASET_COMMUNITY: dataset_dist.get(DATASET_COMMUNITY, 0),
                DATASET_BOT_OPERATION: dataset_dist.get(DATASET_BOT_OPERATION, 0),
                DATASET_MEDIA_REACTION: dataset_dist.get(DATASET_MEDIA_REACTION, 0),
                DATASET_REJECTED_CANDIDATE: dataset_dist.get(DATASET_REJECTED_CANDIDATE, 0),
            },
            "privacyRiskDistribution": dict(sorted(risk_dist.items(), key=lambda x: -x[1])),
            "splitDistribution": {
                TRAIN: split_dist.get(TRAIN, 0),
                REVIEW: split_dist.get(REVIEW, 0),
                EVAL: split_dist.get(EVAL, 0),
            },
            "mediaDependentRatio": round(media_dependent / total, 6) if total else 0,
            "botOutputWindowCount": len(bot_output_windows),
            "botOutputWindowRatio": round(len(bot_output_windows) / total, 6) if total else 0,
            "botOutputWindowByType": dict(sorted(bot_output_by_type.items(), key=lambda x: -x[1])),
            "duplicateExactWindows": duplicate_exact,
            "duplicateApproxRemoved": duplicate_approx_removed,
            "duplicateApproxWindowsRemaining": duplicate_approx_remaining,
            "parseFailures": len(full_result.get("parseFailures", [])),
            "messageCoverageRatio": round(
                len(covered_messages) / gap_stats["uniqueMessages"], 6
            )
            if gap_stats["uniqueMessages"]
            else 0,
            "dataGaps": gap_stats,
        },
        "contribution": {
            "perGroup": {
                k: {
                    "windowCount": v,
                    "windowRatio": round(v / total, 6) if total else 0,
                }
                for k, v in sorted(group_dist.items(), key=lambda x: -x[1])
            },
            "perMonth": dict(sorted(month_dist.items())),
            "topMembers": [
                {"memberHash": h, "windowParticipations": c} for h, c in top_members
            ],
            "top1Ratio": round(top1_ratio, 6),
            "top10Ratio": round(top10_ratio, 6),
        },
        "distributions": {
            "messageCount": _distribution_stats(msg_counts),
            "charCount": _distribution_stats(char_counts),
            "replyDepth": _distribution_stats(reply_depths) if reply_depths else {},
            "mediaDependentCount": media_dependent,
        },
        "sessionThresholds": session_result.get("thresholds", {}),
        "filterReasons": filter_stats,
        "manualReview": {
            "file": "manual-review-v1.jsonl",
            "sampleSize": 300,
            "pool": "community",
        },
    }


def _distribution_stats(values: list[int]) -> dict[str, Any]:
    if not values:
        return {}
    import statistics

    return {
        "min": min(values),
        "max": max(values),
        "mean": round(statistics.mean(values), 3),
        "median": statistics.median(values),
        "p90": _percentile(values, 90),
        "p99": _percentile(values, 99),
    }


def sample_manual_review(windows: list[dict[str, Any]], seed: int, n: int = 300) -> list[dict[str, Any]]:
    rng = random.Random(seed)
    selected: list[dict[str, Any]] = []
    seen: set[str] = set()

    # 1. all high-risk windows must be human-reviewed (privacy audit).
    for w in windows:
        if w["privacy_risk"] == "high":
            selected.append(w)
            seen.add(w["window_id"])

    # 2. stratified sample from the community candidate pool only.
    remaining = [
        w for w in windows
        if w["window_id"] not in seen
        and w.get("dataset", DATASET_COMMUNITY) == DATASET_COMMUNITY
        and w["human_message_count"] >= 2
    ]
    groups = sorted({w["group_id_hash"] for w in remaining})
    types = sorted({w["window_type"] for w in remaining})
    risks = sorted({w["privacy_risk"] for w in remaining})
    buckets: dict[tuple[str, str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for w in remaining:
        buckets[(w["group_id_hash"], w["window_type"], w["privacy_risk"])].append(w)

    combos = [(g, t, r) for g in groups for t in types for r in risks]
    budget = n - len(selected)
    if combos and budget > 0:
        quota = max(1, budget // len(combos))
        for combo in combos:
            bucket = buckets.get(combo, [])
            if not bucket:
                continue
            take = min(len(bucket), quota)
            for w in rng.sample(bucket, take):
                if w["window_id"] not in seen:
                    selected.append(w)
                    seen.add(w["window_id"])

    if len(selected) < n:
        remaining = [
            w for w in windows
            if w["window_id"] not in seen
            and w.get("dataset", DATASET_COMMUNITY) == DATASET_COMMUNITY
            and w["human_message_count"] >= 2
        ]
        for w in rng.sample(remaining, min(len(remaining), n - len(selected))):
            selected.append(w)
            seen.add(w["window_id"])

    selected.sort(key=lambda w: (w["group_id_hash"], w["start_timestamp"]))
    return selected[:n]


def write_manual_review(cfg, windows: list[dict[str, Any]], seed: int) -> list[dict[str, Any]]:
    sample = sample_manual_review(windows, seed, 300)
    out = cfg.reports_dir / "manual-review-v1.jsonl"
    cfg.reports_dir.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for w in sample:
            record = {
                "window_id": w["window_id"],
                "window_type": w["window_type"],
                "dataset": w["dataset"],
                "group_id_hash": w["group_id_hash"],
                "session_id": w["session_id"],
                "split": w["split"],
                "start_timestamp": w["start_timestamp"],
                "end_timestamp": w["end_timestamp"],
                "message_ids": w["message_ids"],
                "text_sanitized": w["text_sanitized"],
                "pii_types": w["pii_types"],
                "pii_confidence": w["pii_confidence"],
                "privacy_risk": w["privacy_risk"],
                "has_media": w["has_media"],
                "media_dependent": w["media_dependent"],
                "char_count": w["char_count"],
                "osu_keyword_count": w["osu_keyword_count"],
                "speaker_count": w["speaker_count"],
                "source_refs": w["source_refs"],
            }
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    return sample


def write_v1_report(cfg, report: dict[str, Any]) -> None:
    cfg.reports_dir.mkdir(parents=True, exist_ok=True)
    (cfg.reports_dir / "window-report-v1.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
