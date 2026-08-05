"""Task 3: window construction (reply_chain / temporal_burst / media_or_bot_reaction).

Output: windows/v1/windows.parquet
"""

from __future__ import annotations

import collections
import json
import pathlib
import re
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .sanitize import OSU_TERMS, window_text


MAX_REPLY_DEPTH = 4
MAX_REPLY_REACTIONS = 4
MAX_WINDOW_MESSAGES = 12
MAX_WINDOW_CHARS = 1200

TYPE_REPLY_CHAIN = "reply_chain"
TYPE_TEMPORAL_BURST = "temporal_burst"
TYPE_MEDIA_BOT = "media_or_bot_reaction"

_OSU_KEYWORD_RE = re.compile(
    r"(?i)\b(" + "|".join(re.escape(t) for t in sorted(OSU_TERMS, key=len, reverse=True)) + r")\b"
)

DATASET_COMMUNITY = "community"
DATASET_BOT_OPERATION = "bot_operation"
DATASET_MEDIA_REACTION = "media_reaction"
DATASET_REJECTED_CANDIDATE = "rejected_candidate"

_COMMAND_RE = re.compile(
    r"(?i)^[\s]*[!/！](?:[A-Za-z0-9_]+|[\u4e00-\u9fa5]+)"
    r"|^[\s]*[~～][\u4e00-\u9fa5A-Za-z0-9_]+"
    r"|^(?:查|查询|绑定|解绑|签到|早安|晚安|今日运势|汇率)\S*"
    r"|^@<MENTION>"
)
_TOKEN_WORD_RE = re.compile(r"[a-z]{3,}")
_CJK_RE = re.compile(r"[\u4e00-\u9fa5]")


def _tokens(text: str) -> set[str]:
    t = (text or "").lower()
    words = set(_TOKEN_WORD_RE.findall(t))
    cjk = _CJK_RE.findall(t)
    bigrams = {cjk[i] + cjk[i + 1] for i in range(len(cjk) - 1)}
    return words | bigrams


def _is_command(row: dict[str, Any]) -> bool:
    if row["is_bot"] or row["is_system"] or row["bot_output_like"]:
        return False
    return bool(_COMMAND_RE.match((row["text_clean"] or "").strip()))


def _is_short_reaction(text: str) -> bool:
    t = text.strip()
    if not t:
        return False
    if len(t) <= 6 and re.fullmatch(r"[0-9A-Za-z\s?!。？，,~～]+", t):
        return True
    if len(t) <= 4:
        return True
    return False


def _coherent_pair(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """Deterministic topic-coherence between adjacent messages.

    Time alone is never enough (the V1 review explicitly rejected 8-minute
    bursts that merely happened close in time). A pair stays in one segment
    only when they are reply-linked, same speaker, share vocabulary, or the
    later message is a short/numeric reaction right after the earlier one.
    """
    if b.get("reply_to_id") and b["reply_to_id"] == a["message_id"]:
        return True
    if a.get("reply_to_id") and a["reply_to_id"] == b["message_id"]:
        return True
    if a["sender_id_hash"] == b["sender_id_hash"]:
        return True
    ta = _tokens(a["text_clean"] or "")
    tb = _tokens(b["text_clean"] or "")
    if ta and tb and (ta & tb):
        return True
    # media and emoji/empty placeholders do not break a conversation
    if a["has_media"] or b["has_media"]:
        return True
    if _is_pure_emoji(a) or _is_pure_emoji(b):
        return True
    if not (a["text_clean"] or "").strip() or not (b["text_clean"] or "").strip():
        return True
    text_b = (b["text_clean"] or "").strip()
    if b["timestamp"] - a["timestamp"] <= 120_000 and (
        _is_short_reaction(text_b) or re.search(r"\d", text_b)
    ):
        return True
    return False


def _segment_boundary(a: dict[str, Any], b: dict[str, Any]) -> bool:
    """True when ``b`` starts a new interaction unit."""
    if a["is_bot"] or a["is_system"] or a["bot_output_like"]:
        return True
    if b["is_bot"] or b["is_system"] or b["bot_output_like"]:
        return True
    if _is_command(a) or _is_command(b):
        return True
    return not _coherent_pair(a, b)


def _has_sufficient_anchor(window_msgs: list[dict[str, Any]]) -> bool:
    """True when human text alone can carry the window's meaning."""
    anchors: list[str] = []
    for m in window_msgs:
        if m["is_bot"] or m["is_system"] or m["bot_output_like"]:
            continue
        t = (m["text_clean"] or "").strip()
        if not t or _is_pure_emoji(m) or _is_command(m):
            continue
        if re.fullmatch(r"@\S+", t):
            continue
        anchors.append(t)
    if not anchors:
        return False
    if any(len(t) >= 8 for t in anchors):
        return True
    return len(anchors) >= 2 and sum(len(t) for t in anchors) >= 12


def _reaction_related(
    m: dict[str, Any],
    prev: dict[str, Any],
    trigger: dict[str, Any],
) -> bool:
    """True when ``m`` can plausibly react to ``trigger`` after ``prev``."""
    if m["timestamp"] - prev["timestamp"] > 180_000:
        return False
    t = (m["text_clean"] or "").strip()
    if not t:
        return True
    if _is_short_reaction(t) or re.search(r"\d", t):
        return True
    if m["sender_id_hash"] == prev["sender_id_hash"]:
        return True
    toks = _tokens(t)
    if toks & (_tokens(prev["text_clean"] or "") | _tokens(trigger["text_clean"] or "")):
        return True
    # the first reaction right after the trigger may be a full sentence
    if prev["message_id"] == trigger["message_id"] and m["timestamp"] - trigger["timestamp"] <= 120_000:
        return True
    return False


def _classify_dataset(window_msgs: list[dict[str, Any]]) -> str:
    has_bot = any(
        m["is_bot"] or m["is_system"] or m["bot_output_like"] for m in window_msgs
    )
    has_cmd = any(not m["is_bot"] and not m["is_system"] and _is_command(m) for m in window_msgs)
    if has_bot or has_cmd:
        return DATASET_BOT_OPERATION
    if _is_spam(window_msgs):
        return DATASET_REJECTED_CANDIDATE
    unanchored_media = any(
        m["has_media"] and not (m["text_clean"] or "").strip() for m in window_msgs
    )
    if unanchored_media and not _has_sufficient_anchor(window_msgs):
        return DATASET_MEDIA_REACTION
    if not _has_sufficient_anchor(window_msgs):
        return DATASET_REJECTED_CANDIDATE
    return DATASET_COMMUNITY


def _dedupe_near_duplicates(
    windows: list[dict[str, Any]],
    threshold: float = 0.8,
) -> tuple[list[dict[str, Any]], int, dict[str, Any]]:
    """Remove windows whose message sets overlap another by >= threshold.

    Deterministic: longer windows win, then earlier start, then stable id.
    Returns (kept windows, removed count, removal stats).
    """
    order = sorted(
        range(len(windows)),
        key=lambda i: (-len(windows[i]["message_ids"]), windows[i]["start_timestamp"], windows[i]["window_id"]),
    )
    kept_flags = [False] * len(windows)
    by_msg: dict[tuple[str, str], list[int]] = {}
    removed = 0
    reasons: collections.Counter[str] = collections.Counter()
    overlaps: list[float] = []
    for i in order:
        w = windows[i]
        mids = set(w["message_ids"])
        toks = _tokens(" ".join((m["text_clean"] or "") for m in w["_messages"]))
        sid = w["session_id"]
        candidates: set[int] = set()
        for mid in mids:
            candidates.update(by_msg.get((sid, mid), ()))
        dup = False
        for j in candidates:
            other = set(windows[j]["message_ids"])
            union = len(mids | other)
            mid_sim = len(mids & other) / union if union else 0.0
            if mid_sim >= threshold:
                reasons["message_ids_jaccard"] += 1
                overlaps.append(mid_sim)
                dup = True
                break
            # same trigger + heavy time-range overlap + strong content overlap
            if windows[j]["trigger_message_id"] == w["trigger_message_id"]:
                other_toks = _tokens(
                    " ".join((m["text_clean"] or "") for m in windows[j]["_messages"])
                )
                t_union = len(toks | other_toks)
                tok_sim = len(toks & other_toks) / t_union if t_union else 0.0
                a_span = w["end_timestamp"] - w["start_timestamp"]
                b_span = windows[j]["end_timestamp"] - windows[j]["start_timestamp"]
                lo = max(w["start_timestamp"], windows[j]["start_timestamp"])
                hi = min(w["end_timestamp"], windows[j]["end_timestamp"])
                span_union = max(w["end_timestamp"], windows[j]["end_timestamp"]) - min(
                    w["start_timestamp"], windows[j]["start_timestamp"]
                )
                time_sim = max(0, hi - lo) / span_union if span_union else 0.0
                if time_sim >= 0.8 and (mid_sim >= 0.6 or tok_sim >= 0.8):
                    reasons["trigger_time_text"] += 1
                    overlaps.append(max(mid_sim, tok_sim))
                    dup = True
                    break
        if dup:
            removed += 1
            continue
        kept_flags[i] = True
        for mid in mids:
            by_msg.setdefault((sid, mid), []).append(i)
    stats: dict[str, Any] = {"reasons": dict(reasons)}
    if overlaps:
        ordered = sorted(overlaps)
        stats["overlap_mean"] = round(sum(ordered) / len(ordered), 4)
        stats["overlap_p90"] = round(ordered[int(len(ordered) * 0.9) - 1], 4)
        stats["overlap_max"] = round(ordered[-1], 4)
    return [w for w, kept in zip(windows, kept_flags) if kept], removed, stats


def _load_rows(table: pa.Table) -> dict[str, dict[str, Any]]:
    """Build message_id -> row dict for the full table."""
    cols = [
        "message_id",
        "group_id_hash",
        "sender_id_hash",
        "timestamp",
        "seq",
        "reply_to_id",
        "message_type",
        "text_raw",
        "text_clean",
        "has_media",
        "media_type",
        "is_bot",
        "is_system",
        "bot_output_like",
        "source_file",
        "source_offset",
        "source_offset_bytes",
        "source_export",
    ]
    arrays = {c: table.column(c).to_pylist() for c in cols}
    rows: dict[str, dict[str, Any]] = {}
    for i in range(table.num_rows):
        mid = arrays["message_id"][i]
        rows[mid] = {c: arrays[c][i] for c in cols}
    return rows


def _is_pure_emoji(row: dict[str, Any]) -> bool:
    t = row["message_type"]
    text = (row["text_clean"] or "").strip()
    if t in ("type_17", "unknown") and not text:
        return True
    if text and re.fullmatch(r"[\[\]【】\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\s]*", text):
        return True
    return False


def _is_spam(window_msgs: list[dict[str, Any]]) -> bool:
    texts = [m["text_clean"] or "" for m in window_msgs]
    nonempty = [t for t in texts if t.strip()]
    if not nonempty:
        return True
    counts = collections.Counter(t.strip() for t in nonempty)
    top_ratio = max(counts.values()) / len(nonempty)
    if top_ratio > 0.6:
        return True
    for i in range(len(texts) - 3):
        if texts[i] and texts[i] == texts[i + 1] == texts[i + 2] == texts[i + 3]:
            return True
    return False


def _burst_ok(window_msgs: list[dict[str, Any]]) -> bool:
    if len(window_msgs) < 3:
        return False
    humans = [m for m in window_msgs if not m["is_bot"] and not m["is_system"]]
    if len({m["sender_id_hash"] for m in humans}) < 2:
        return False
    if all(m["is_bot"] or m["is_system"] or _is_pure_emoji(m) for m in window_msgs):
        return False
    if _is_spam(window_msgs):
        return False
    return True


def _trim_chars(window_msgs: list[dict[str, Any]], limit: int = MAX_WINDOW_CHARS) -> list[dict[str, Any]]:
    """Deterministically trim to <= limit characters.

    Reactions are dropped from the tail first, then the oldest ancestor.
    """
    total = sum(len(m["text_clean"] or "") for m in window_msgs)
    if total <= limit:
        return window_msgs
    msgs = list(window_msgs)
    # drop from tail (reactions)
    while len(msgs) > 2 and sum(len(m["text_clean"] or "") for m in msgs) > limit:
        msgs.pop()
    # still too long: drop oldest ancestors from the front
    while len(msgs) > 2 and sum(len(m["text_clean"] or "") for m in msgs) > limit:
        msgs.pop(0)
    return msgs


def _window_record(
    window_id: str,
    window_type: str,
    group_hash: str,
    session_id: str,
    trigger_message_id: str,
    window_msgs: list[dict[str, Any]],
    reply_depth: int,
    media_dependent: bool,
    sender_names: dict[str, str],
) -> dict[str, Any]:
    if not window_msgs:
        raise ValueError("empty window")
    window_msgs = _trim_chars(window_msgs)
    if len(window_msgs) < 1:
        return None  # type: ignore[return-value]

    enriched = []
    for m in window_msgs:
        r = dict(m)
        r["sender_name"] = sender_names.get(m["message_id"], "")
        enriched.append(r)

    text_sanitized, pii_types, pii_confidence, privacy_risk = window_text(enriched)
    speaker_ids = sorted({m["sender_id_hash"] for m in enriched})
    human_count = sum(1 for m in enriched if not m["is_bot"] and not m["is_system"])
    bot_count = sum(1 for m in enriched if m["is_bot"])
    bot_output_count = sum(1 for m in enriched if m["bot_output_like"])
    osu_count = len(_OSU_KEYWORD_RE.findall(text_sanitized))
    source_refs = [
        {
            "source_export": m["source_export"],
            "source_file": m["source_file"],
            "source_offset": m["source_offset"],
            "source_offset_bytes": m["source_offset_bytes"],
            "message_id": m["message_id"],
        }
        for m in enriched
    ]
    return {
        "window_id": window_id,
        "window_type": window_type,
        "group_id_hash": group_hash,
        "session_id": session_id,
        "start_timestamp": min(m["timestamp"] for m in enriched),
        "end_timestamp": max(m["timestamp"] for m in enriched),
        "trigger_message_id": trigger_message_id,
        "message_ids": [m["message_id"] for m in enriched],
        "dataset": _classify_dataset(enriched),
        "speaker_ids": speaker_ids,
        "speaker_count": len(speaker_ids),
        "human_message_count": human_count,
        "bot_message_count": bot_count,
        "bot_output_count": bot_output_count,
        "reply_depth": reply_depth,
        "text_sanitized": text_sanitized,
        "has_media": any(m["has_media"] for m in enriched),
        "media_dependent": media_dependent,
        "pii_types": pii_types,
        "pii_confidence": pii_confidence,
        "privacy_risk": privacy_risk,
        "osu_keyword_count": osu_count,
        "char_count": len(text_sanitized),
        "source_refs": source_refs,
        "split": None,
        "_messages": enriched,
    }


def build_windows(
    table: pa.Table,
    sessions: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    rows = _load_rows(table)
    msg_to_session: dict[str, str] = {}
    for s in sessions:
        for mid in s["message_ids"]:
            msg_to_session[mid] = s["session_id"]

    windows: list[dict[str, Any]] = []
    dedupe: dict[tuple[str, ...], int] = {}
    counter = 0
    filter_stats: dict[str, int] = collections.Counter()

    for session in sessions:
        group_hash = session["group_id_hash"]
        session_id = session["session_id"]
        msgs = [rows[mid] for mid in session["message_ids"] if mid in rows]
        context = [rows[mid] for mid in session.get("context_message_ids", []) if mid in rows]
        msgs.sort(key=lambda m: (m["timestamp"], m["seq"]))
        context.sort(key=lambda m: (m["timestamp"], m["seq"]))

        # ---- A. reply_chain ----
        for trigger in msgs:
            if not trigger["reply_to_id"]:
                continue
            ref_id = trigger["reply_to_id"]
            if ref_id not in rows:
                filter_stats["reply_chain_ref_not_found"] += 1
                continue
            chain: list[dict[str, Any]] = []
            cur = ref_id
            seen: set[str] = set()
            depth = 0
            while cur in rows and cur not in seen and depth < MAX_REPLY_DEPTH:
                seen.add(cur)
                chain.append(rows[cur])
                cur = rows[cur]["reply_to_id"]
                depth += 1
            chain.reverse()
            seq_msgs = chain + [trigger]
            # reactions: following messages in the same session
            try:
                idx = next(i for i, m in enumerate(msgs) if m["message_id"] == trigger["message_id"])
            except StopIteration:
                continue
            reactions = msgs[idx + 1 : idx + 1 + MAX_REPLY_REACTIONS]
            window_msgs = seq_msgs + reactions
            if len(window_msgs) < 2:
                filter_stats["reply_chain_too_short"] += 1
                continue
            rec = _window_record(
                f"W{counter:08d}",
                TYPE_REPLY_CHAIN,
                group_hash,
                session_id,
                trigger["message_id"],
                window_msgs,
                depth,
                False,
                {},
            )
            counter += 1
            if rec is None:
                continue
            key = tuple(rec["message_ids"])
            if key not in dedupe:
                dedupe[key] = len(windows)
                windows.append(rec)
            else:
                filter_stats["window_duplicate_message_ids"] += 1

        # ---- B. temporal_burst ----
        segments: list[list[dict[str, Any]]] = []
        current: list[dict[str, Any]] = []
        for m in msgs:
            if not current:
                current.append(m)
                continue
            if _segment_boundary(current[-1], m):
                segments.append(current)
                current = [m]
            else:
                current.append(m)
        if current:
            segments.append(current)

        for seg in segments:
            n = len(seg)
            i = 0
            while i < n:
                found = False
                skip_reason = None
                # largest valid window first, then jump: no shifted re-cuts
                for w in range(min(MAX_WINDOW_MESSAGES, n - i), 2, -1):
                    cand = seg[i : i + w]
                    if _burst_ok(cand):
                        trigger_id = next(
                            (m["message_id"] for m in cand if not m["is_bot"] and not m["is_system"]),
                            cand[0]["message_id"],
                        )
                        rec = _window_record(
                            f"W{counter:08d}",
                            TYPE_TEMPORAL_BURST,
                            group_hash,
                            session_id,
                            trigger_id,
                            cand,
                            0,
                            False,
                            {},
                        )
                        counter += 1
                        if rec is not None:
                            key = tuple(rec["message_ids"])
                            if key not in dedupe:
                                dedupe[key] = len(windows)
                                windows.append(rec)
                            else:
                                filter_stats["window_duplicate_message_ids"] += 1
                        i += w
                        found = True
                        break
                    else:
                        humans = [m for m in cand if not m["is_bot"] and not m["is_system"]]
                        if len({m["sender_id_hash"] for m in humans}) < 2:
                            skip_reason = "burst_fewer_than_2_human_speakers"
                        elif not any(
                            (m["text_clean"] or "").strip() and not _is_pure_emoji(m)
                            for m in humans
                        ):
                            skip_reason = "burst_no_human_text"
                        elif all(m["is_bot"] or m["is_system"] or _is_pure_emoji(m) for m in cand):
                            skip_reason = "burst_bot_system_or_emoji_only"
                        elif _is_spam(cand):
                            skip_reason = "burst_spam"
                if not found:
                    if skip_reason:
                        filter_stats[skip_reason] += 1
                    i += 1

        # ---- C. media_or_bot_reaction ----
        for trigger in msgs:
            is_bot_trigger = (
                trigger["is_bot"] or trigger["is_system"] or trigger["bot_output_like"]
            )
            is_media_trigger = bool(trigger["has_media"])
            if not (is_bot_trigger or is_media_trigger):
                continue
            try:
                idx = next(i for i, m in enumerate(msgs) if m["message_id"] == trigger["message_id"])
            except StopIteration:
                continue

            # preceding command: bot output / bot-rendered image belongs to it
            pre: list[dict[str, Any]] = []
            if is_bot_trigger or (is_media_trigger and not (trigger["text_clean"] or "").strip()):
                for j in range(idx - 1, max(-1, idx - 6), -1):
                    m = msgs[j]
                    between = msgs[j + 1 : idx]
                    if _is_command(m):
                        if not any(
                            x["has_media"]
                            or x["is_bot"]
                            or x["is_system"]
                            or x["bot_output_like"]
                            or (x["text_clean"] or "").strip()
                            for x in between
                        ):
                            pre = [m]
                        break
                    if trigger["timestamp"] - m["timestamp"] > 60_000:
                        break

            reaction_msgs: list[dict[str, Any]] = []
            prev = trigger
            for m in msgs[idx + 1 :]:
                if m["is_bot"] or m["is_system"] or m["bot_output_like"] or _is_command(m):
                    break
                if not (m["text_clean"] or "").strip() and not m["has_media"]:
                    continue
                if _is_pure_emoji(m):
                    continue
                if reaction_msgs and not _reaction_related(m, prev, trigger):
                    break
                reaction_msgs.append(m)
                prev = m
                if len(reaction_msgs) >= 8:
                    break
            window_msgs = pre + [trigger] + reaction_msgs
            if len(reaction_msgs) == 0:
                filter_stats["media_bot_no_reactions"] += 1
            media_dependent = bool(trigger["has_media"]) and not (trigger["text_clean"] or "").strip()
            rec = _window_record(
                f"W{counter:08d}",
                TYPE_MEDIA_BOT,
                group_hash,
                session_id,
                trigger["message_id"],
                window_msgs,
                0,
                media_dependent,
                {},
            )
            counter += 1
            if rec is None:
                continue
            key = tuple(rec["message_ids"])
            if key not in dedupe:
                dedupe[key] = len(windows)
                windows.append(rec)
            else:
                filter_stats["window_duplicate_message_ids"] += 1

    before_dedup = len(windows)
    windows, removed, dedup_stats = _dedupe_near_duplicates(windows)
    filter_stats["near_duplicate_removed"] += removed
    filter_stats["windows_before_dedup"] = before_dedup
    filter_stats["windows_after_dedup"] = len(windows)
    for reason, count in dedup_stats.get("reasons", {}).items():
        filter_stats[f"near_duplicate_removed_by_{reason}"] += count
    for stat_key in ("overlap_mean", "overlap_p90", "overlap_max"):
        if stat_key in dedup_stats:
            filter_stats[f"near_duplicate_{stat_key}"] = dedup_stats[stat_key]
    return windows, dict(filter_stats)


def finalize_window_texts(windows: list[dict[str, Any]], sender_names: dict[str, str]) -> None:
    """Fill sender names and recompute sanitized text fields in place."""
    for w in windows:
        enriched = w["_messages"]
        for m in enriched:
            m["sender_name"] = sender_names.get(m["message_id"], "")
        text, pii_types, pii_confidence, privacy_risk = window_text(enriched)
        w["text_sanitized"] = text
        w["pii_types"] = pii_types
        w["pii_confidence"] = pii_confidence
        w["privacy_risk"] = privacy_risk
        w["osu_keyword_count"] = len(_OSU_KEYWORD_RE.findall(text))
        w["char_count"] = len(text)


def write_windows(cfg, windows: list[dict[str, Any]]) -> pathlib.Path:
    out_dir = cfg.output_dir / "windows" / "v1"
    out_dir.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "window_id": pa.array([w["window_id"] for w in windows], type=pa.string()),
            "window_type": pa.array([w["window_type"] for w in windows], type=pa.string()),
            "group_id_hash": pa.array([w["group_id_hash"] for w in windows], type=pa.string()),
            "session_id": pa.array([w["session_id"] for w in windows], type=pa.string()),
            "start_timestamp": pa.array([w["start_timestamp"] for w in windows], type=pa.int64()),
            "end_timestamp": pa.array([w["end_timestamp"] for w in windows], type=pa.int64()),
            "trigger_message_id": pa.array([w["trigger_message_id"] for w in windows], type=pa.string()),
            "message_ids": pa.array([w["message_ids"] for w in windows], type=pa.list_(pa.string())),
            "dataset": pa.array([w["dataset"] for w in windows], type=pa.string()),
            "speaker_ids": pa.array([w["speaker_ids"] for w in windows], type=pa.list_(pa.string())),
            "speaker_count": pa.array([w["speaker_count"] for w in windows], type=pa.int64()),
            "human_message_count": pa.array([w["human_message_count"] for w in windows], type=pa.int64()),
            "bot_message_count": pa.array([w["bot_message_count"] for w in windows], type=pa.int64()),
            "bot_output_count": pa.array([w["bot_output_count"] for w in windows], type=pa.int64()),
            "reply_depth": pa.array([w["reply_depth"] for w in windows], type=pa.int64()),
            "text_sanitized": pa.array([w["text_sanitized"] for w in windows], type=pa.string()),
            "has_media": pa.array([w["has_media"] for w in windows], type=pa.bool_()),
            "media_dependent": pa.array([w["media_dependent"] for w in windows], type=pa.bool_()),
            "pii_types": pa.array([w["pii_types"] for w in windows], type=pa.list_(pa.string())),
            "pii_confidence": pa.array([w["pii_confidence"] for w in windows], type=pa.string()),
            "privacy_risk": pa.array([w["privacy_risk"] for w in windows], type=pa.string()),
            "osu_keyword_count": pa.array([w["osu_keyword_count"] for w in windows], type=pa.int64()),
            "char_count": pa.array([w["char_count"] for w in windows], type=pa.int64()),
            "source_refs": pa.array(
                [json.dumps(w["source_refs"], ensure_ascii=False) for w in windows], type=pa.string()
            ),
            "split": pa.array([w["split"] for w in windows], type=pa.string()),
        }
    )
    out = out_dir / "windows.parquet"
    pq.write_table(table, out)
    return out
