"""Task 2: session construction.

Rules:
- messages are sorted by (group_id_hash, timestamp, seq);
- a new session starts when the gap to the previous message exceeds
  ``gap_minutes`` (default 8 minutes);
- reply relations may pull a referenced message into the session as
  context (context_message_ids); the message stays in its original session;
- over-long sessions are deterministically split into segments so no
  message is lost;
- output: normalized/full/sessions.parquet + session threshold stats.
"""

from __future__ import annotations

import collections
import json
import statistics
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq


MAX_SESSION_MESSAGES = 500
SEGMENT_SIZE = 250


def load_full_messages(cfg):
    table = pq.read_table(cfg.normalized_dir / "full" / "messages.parquet")
    return table.to_pylist()


def build_sessions(messages: list[dict[str, Any]], gap_minutes: int = 8) -> list[dict[str, Any]]:
    """Build sessions per group. Returns list of session dicts."""
    by_group: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for m in messages:
        by_group[m["group_id_hash"]].append(m)

    sessions: list[dict[str, Any]] = []
    gap_ms = gap_minutes * 60_000
    for group_hash in sorted(by_group):
        msgs = sorted(by_group[group_hash], key=lambda m: (m["timestamp"], m["seq"]))
        group_sessions: list[list[dict[str, Any]]] = []
        cur: list[dict[str, Any]] = []
        prev_ts: int | None = None

        def flush() -> None:
            nonlocal cur
            if cur:
                group_sessions.append(cur)
                cur = []

        for m in msgs:
            if prev_ts is not None and m["timestamp"] - prev_ts > gap_ms:
                flush()
            cur.append(m)
            prev_ts = m["timestamp"]
        flush()

        # split over-long sessions deterministically
        segmented: list[list[dict[str, Any]]] = []
        for ses in group_sessions:
            if len(ses) <= MAX_SESSION_MESSAGES:
                segmented.append(ses)
            else:
                for start in range(0, len(ses), SEGMENT_SIZE):
                    segmented.append(ses[start : start + SEGMENT_SIZE])

        # reply context: attach referenced message to the replying session
        msg_to_session: dict[str, str] = {}
        session_counter = len(sessions)
        for idx, ses in enumerate(segmented):
            sid = f"{group_hash[:12]}-s{session_counter + idx:06d}"
            for m in ses:
                msg_to_session[m["message_id"]] = sid

        context_map: dict[str, list[str]] = collections.defaultdict(list)
        for ses in segmented:
            sid = msg_to_session[ses[0]["message_id"]]
            for m in ses:
                ref = m.get("reply_to_id")
                if ref and ref in msg_to_session and msg_to_session[ref] != sid:
                    context_map[sid].append(ref)

        for idx, ses in enumerate(segmented):
            sid = f"{group_hash[:12]}-s{session_counter + idx:06d}"
            context_ids = sorted(set(context_map.get(sid, [])))
            sessions.append(
                {
                    "session_id": sid,
                    "group_id_hash": group_hash,
                    "start_timestamp": ses[0]["timestamp"],
                    "end_timestamp": ses[-1]["timestamp"],
                    "message_ids": [m["message_id"] for m in ses],
                    "context_message_ids": context_ids,
                    "message_count": len(ses),
                    "speaker_count": len({m["sender_id_hash"] for m in ses}),
                }
            )

    sessions.sort(key=lambda s: (s["group_id_hash"], s["start_timestamp"], s["session_id"]))
    return sessions


def threshold_stats(messages: list[dict[str, Any]], thresholds=(3, 5, 8, 15)) -> dict[str, Any]:
    stats: dict[str, Any] = {}
    for t in thresholds:
        sessions = build_sessions(messages, gap_minutes=t)
        counts = [s["message_count"] for s in sessions]
        single_speaker = sum(1 for s in sessions if s["speaker_count"] <= 1)
        stats[str(t)] = {
            "sessionCount": len(sessions),
            "avgMessages": round(statistics.mean(counts), 3) if counts else 0,
            "medianMessages": statistics.median(counts) if counts else 0,
            "p90Messages": _percentile(counts, 90) if counts else 0,
            "p99Messages": _percentile(counts, 99) if counts else 0,
            "singleSpeakerRatio": round(single_speaker / len(sessions), 6) if sessions else 0,
        }
    return stats


def _percentile(values: list[int], p: int) -> float:
    values = sorted(values)
    if not values:
        return 0.0
    k = (len(values) - 1) * p / 100.0
    lo = int(k)
    hi = min(lo + 1, len(values) - 1)
    return values[lo] + (values[hi] - values[lo]) * (k - lo)


def sessions_table(sessions: list[dict[str, Any]]) -> pa.Table:
    return pa.table(
        {
            "session_id": pa.array([s["session_id"] for s in sessions], type=pa.string()),
            "group_id_hash": pa.array([s["group_id_hash"] for s in sessions], type=pa.string()),
            "start_timestamp": pa.array([s["start_timestamp"] for s in sessions], type=pa.int64()),
            "end_timestamp": pa.array([s["end_timestamp"] for s in sessions], type=pa.int64()),
            "message_count": pa.array([s["message_count"] for s in sessions], type=pa.int64()),
            "speaker_count": pa.array([s["speaker_count"] for s in sessions], type=pa.int64()),
            "message_ids": pa.array([s["message_ids"] for s in sessions], type=pa.list_(pa.string())),
            "context_message_ids": pa.array(
                [s["context_message_ids"] for s in sessions], type=pa.list_(pa.string())
            ),
        }
    )


def write_sessions(cfg, sessions: list[dict[str, Any]], threshold_stats_data: dict[str, Any]) -> dict[str, Any]:
    out_dir = cfg.normalized_dir / "full"
    out_dir.mkdir(parents=True, exist_ok=True)
    pq.write_table(sessions_table(sessions), out_dir / "sessions.parquet")
    stats_path = cfg.reports_dir / "session-threshold-stats.json"
    cfg.reports_dir.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(json.dumps(threshold_stats_data, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "sessionCount": len(sessions),
        "thresholds": threshold_stats_data,
        "statsFile": str(stats_path),
    }
