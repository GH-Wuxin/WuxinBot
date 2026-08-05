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
    TIER_STYLE_READY,
    TIER_CONTEXTUAL_STYLE,
    TIER_BOT_INTERACTION,
    TIER_AMBIENT_CHAT,
    TIER_PRIVATE_REJECTED,
    TYPE_REPLY_CHAIN,
    TYPE_TEMPORAL_BURST,
    TYPE_MEDIA_BOT,
)


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
    tier_dist = collections.Counter(w["usage_tier"] for w in windows)
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
    duplicate_exact = filter_stats.get("duplicate_exact_removed", 0)
    near_dup_clusters = filter_stats.get("near_duplicate_clusters", 0)
    near_dup_clustered = filter_stats.get("near_duplicate_clustered_windows", 0)
    near_dup_max_size = filter_stats.get("near_duplicate_max_cluster_size", 1)
    near_dup_overlap = {
        k: filter_stats[k]
        for k in ("near_duplicate_overlap_mean", "near_duplicate_overlap_p90", "near_duplicate_overlap_max")
        if k in filter_stats
    }
    near_dup_reasons = {
        k.removeprefix("near_duplicate_by_"): v
        for k, v in filter_stats.items()
        if k.startswith("near_duplicate_by_")
    }
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
            "windowTypeDistribution": {
                TYPE_REPLY_CHAIN: type_dist.get(TYPE_REPLY_CHAIN, 0),
                TYPE_TEMPORAL_BURST: type_dist.get(TYPE_TEMPORAL_BURST, 0),
                TYPE_MEDIA_BOT: type_dist.get(TYPE_MEDIA_BOT, 0),
            },
            "usageTierDistribution": {
                TIER_STYLE_READY: tier_dist.get(TIER_STYLE_READY, 0),
                TIER_CONTEXTUAL_STYLE: tier_dist.get(TIER_CONTEXTUAL_STYLE, 0),
                TIER_BOT_INTERACTION: tier_dist.get(TIER_BOT_INTERACTION, 0),
                TIER_AMBIENT_CHAT: tier_dist.get(TIER_AMBIENT_CHAT, 0),
                TIER_PRIVATE_REJECTED: tier_dist.get(TIER_PRIVATE_REJECTED, 0),
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
            "nearDuplicateClusters": near_dup_clusters,
            "nearDuplicateClusteredWindows": near_dup_clustered,
            "nearDuplicateMaxClusterSize": near_dup_max_size,
            "nearDuplicateOverlap": near_dup_overlap,
            "nearDuplicateReasons": near_dup_reasons,
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
            "pool": "style_ready/contextual_style/ambient_chat/bot_interaction stratified + all high-risk",
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
    seen_clusters: set[str] = set()

    # 1. all high-risk windows must be human-reviewed (privacy audit).
    for w in windows:
        if w["privacy_risk"] == "high":
            selected.append(w)
            seen.add(w["window_id"])
            cid = w.get("overlap_cluster_id")
            if cid:
                seen_clusters.add(cid)

    # 2. stratified sample across the non-private tiers; never pick two
    #    windows from the same overlap cluster (review pollution control).
    tiers = [
        TIER_STYLE_READY,
        TIER_CONTEXTUAL_STYLE,
        TIER_AMBIENT_CHAT,
        TIER_BOT_INTERACTION,
    ]

    def eligible(w: dict[str, Any]) -> bool:
        if w["window_id"] in seen:
            return False
        tier = w.get("usage_tier", "")
        if tier not in tiers:
            return False
        if tier != TIER_BOT_INTERACTION and w.get("human_message_count", 0) < 1:
            return False
        cid = w.get("overlap_cluster_id")
        return not (cid and cid in seen_clusters)

    remaining = [w for w in windows if eligible(w)]
    groups = sorted({w["group_id_hash"] for w in remaining})
    types = sorted({w["window_type"] for w in remaining})
    risks = sorted({w["privacy_risk"] for w in remaining})
    buckets: dict[tuple[str, str, str, str], list[dict[str, Any]]] = collections.defaultdict(list)
    for w in remaining:
        buckets[
            (
                w.get("usage_tier", ""),
                w["group_id_hash"],
                w["window_type"],
                w["privacy_risk"],
            )
        ].append(w)

    combos = [
        (t, g, ty, r)
        for t in tiers
        for g in groups
        for ty in types
        for r in risks
    ]
    budget = n - len(selected)
    if combos and budget > 0:
        quota = max(1, budget // len(combos))
        for combo in combos:
            bucket = [w for w in buckets.get(combo, []) if eligible(w)]
            if not bucket:
                continue
            take = min(len(bucket), quota)
            for w in rng.sample(bucket, take):
                selected.append(w)
                seen.add(w["window_id"])
                cid = w.get("overlap_cluster_id")
                if cid:
                    seen_clusters.add(cid)

    if len(selected) < n:
        remaining = [
            w for w in windows
            if eligible(w)
        ]
        for w in rng.sample(remaining, min(len(remaining), n - len(selected))):
            selected.append(w)
            seen.add(w["window_id"])
            cid = w.get("overlap_cluster_id")
            if cid:
                seen_clusters.add(cid)

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
                "usage_tier": w["usage_tier"],
                "overlap_cluster_id": w["overlap_cluster_id"],
                "overlap_cluster_representative": w["overlap_cluster_representative"],
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
