"""Import quality report generation."""

from __future__ import annotations

import collections
import json
from typing import Any

import pyarrow.parquet as pq

from .config import Config


def build_report(cfg: Config, pipeline_result: dict[str, Any]) -> dict[str, Any]:
    table = pq.read_table(cfg.normalized_dir / "messages.parquet")
    rows = table.to_pylist()
    total = len(rows)

    per_file: dict[str, dict[str, Any]] = {}
    type_counts: collections.Counter[str] = collections.Counter()
    groups: set[str] = set()
    senders: set[str] = set()
    bot_count = 0
    system_count = 0
    media_count = 0
    text_count = 0
    pii_count = 0
    reply_count = 0
    reply_resolved = 0
    reply_linked = 0
    timestamps: list[int] = []
    unknown_count = 0

    for r in rows:
        per_file.setdefault(
            r["source_file"],
            {
                "messageCount": 0,
                "timeStartMs": None,
                "timeEndMs": None,
                "types": collections.Counter(),
            },
        )
        pf = per_file[r["source_file"]]
        pf["messageCount"] += 1
        pf["timeStartMs"] = r["timestamp"] if pf["timeStartMs"] is None else min(pf["timeStartMs"], r["timestamp"])
        pf["timeEndMs"] = r["timestamp"] if pf["timeEndMs"] is None else max(pf["timeEndMs"], r["timestamp"])
        pf["types"][r["message_type"]] += 1

        type_counts[r["message_type"]] += 1
        groups.add(r["group_id_hash"])
        senders.add(r["sender_id_hash"])
        bot_count += 1 if r["is_bot"] else 0
        system_count += 1 if r["is_system"] else 0
        media_count += 1 if r["has_media"] else 0
        text_count += 1 if r["message_type"] == "text" else 0
        pii_count += 1 if r["has_pii"] else 0
        timestamps.append(r["timestamp"])
        if r["message_type"] == "unknown":
            unknown_count += 1
        if r["message_type"] == "reply":
            reply_count += 1
            if r["reply_to_id"]:
                reply_resolved += 1
                if r["reply_to_id"] in {x["message_id"] for x in rows}:
                    reply_linked += 1

    # duplicate messages: same group + sender + timestamp + cleaned text
    dup_counter: collections.Counter[tuple[Any, ...]] = collections.Counter()
    for r in rows:
        key = (r["group_id_hash"], r["sender_id_hash"], r["timestamp"], r["text_clean"])
        dup_counter[key] += 1
    duplicate_count = sum(1 for v in dup_counter.values() if v > 1)

    # parse failures (dedupe previews, keep sample)
    failures = pipeline_result.get("parse_failures", [])
    failure_samples = failures[:10]

    per_file_report = {}
    for name, pf in sorted(per_file.items()):
        per_file_report[name] = {
            "messageCount": pf["messageCount"],
            "timeStart": _iso(pf["timeStartMs"]),
            "timeEnd": _iso(pf["timeEndMs"]),
            "typeDistribution": dict(sorted(pf["types"].items(), key=lambda x: -x[1])),
        }

    return {
        "generatedAt": None,
        "summary": {
            "totalMessages": total,
            "timeStart": _iso(min(timestamps)) if timestamps else None,
            "timeEnd": _iso(max(timestamps)) if timestamps else None,
            "groups": len(groups),
            "members": len(senders),
            "unknownTypes": unknown_count,
            "duplicateMessages": duplicate_count,
            "piiRiskMessages": pii_count,
            "parseFailures": len(failures),
        },
        "typeDistribution": dict(sorted(type_counts.items(), key=lambda x: -x[1])),
        "ratios": {
            "bot": round(bot_count / total, 6) if total else 0,
            "system": round(system_count / total, 6) if total else 0,
            "media": round(media_count / total, 6) if total else 0,
            "text": round(text_count / total, 6) if total else 0,
        },
        "replyReference": {
            "replyMessages": reply_count,
            "resolved": reply_resolved,
            "resolvedRate": round(reply_resolved / reply_count, 6) if reply_count else 0,
            "linkedInBatch": reply_linked,
            "linkedRate": round(reply_linked / reply_count, 6) if reply_count else 0,
        },
        "perFile": per_file_report,
        "parseFailureSamples": failure_samples,
    }


def _iso(ms: int | None) -> str | None:
    if ms is None:
        return None
    import datetime

    return datetime.datetime.fromtimestamp(ms / 1000, tz=datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def write_report(cfg: Config, report: dict[str, Any]) -> None:
    (cfg.reports_dir / "import-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
