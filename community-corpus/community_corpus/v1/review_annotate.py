"""Annotate the V1 manual-review sample with per-message provenance.

The corpus itself is fully sanitized; this module is a human-review aid only.
For every window it resolves each message's authoritative fields from
``messages.parquet`` (message_type / has_media / is_bot / is_system) and
adds a review-only ``bot_name_like`` flag when the raw sender matches known
bot accounts or strict bot-like names. Nothing here changes the sample or
the training corpus.

Output: reports/manual-review-v1-annotated.jsonl
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
from typing import Any

import pyarrow.parquet as pq

from .sanitize import sanitize_text


# pippi + bots found in the exported groups (raw sender uin).
KNOWN_BOT_UINS = {
    "REDACTED_QQ_002",  # pippi
    "2225126759",  # Lazybot 测试机
    "1563653406",  # 雨沐Bot
    "3889024489",  # 可怜BOT
}
BOT_NAME_RE = re.compile(
    r"^(?:pippi|lazybot|雨沐bot|可怜bot)(?:[\s|丨\-].*)?$",
    re.IGNORECASE,
)
ROLE_HUMAN = "human"
ROLE_BOT = "bot"
ROLE_SYSTEM = "system"


def _message_index(messages_path: pathlib.Path) -> dict[tuple[str, str, str, int], dict[str, Any]]:
    t = pq.read_table(
        messages_path,
        columns=[
            "message_id",
            "message_type",
            "has_media",
            "media_type",
            "sender_id_hash",
            "is_bot",
            "is_system",
            "bot_output_like",
            "text_clean",
            "source_export",
            "source_file",
            "source_offset_bytes",
        ],
    )
    index: dict[tuple[str, str, str, int], dict[str, Any]] = {}
    for r in t.to_pylist():
        key = (
            r["message_id"],
            r["source_export"],
            r["source_file"],
            r["source_offset_bytes"],
        )
        index[key] = r
    return index


def _sender_identity(raw_line: str) -> tuple[str, str]:
    uin = re.search(r'"uin":"(\d+)"', raw_line)
    name = re.search(r'"(?:groupCard|name)":"([^"]*)"', raw_line)
    return (
        uin.group(1) if uin else "",
        name.group(1) if name else "",
    )


def annotate_window(
    window: dict[str, Any],
    msg_index: dict[tuple[str, str, str, int], dict[str, Any]],
    exports_root: pathlib.Path,
) -> list[dict[str, Any]]:
    """Return per-message annotation records in window order."""
    lines: list[dict[str, Any]] = []
    for ref in window["source_refs"]:
        key = (
            ref["message_id"],
            ref["source_export"],
            ref["source_file"],
            ref["source_offset_bytes"],
        )
        meta = msg_index.get(key)
        uin = ""
        sender_name = ""
        try:
            p = exports_root / ref["source_export"] / ref["source_file"]
            with p.open("r", encoding="utf-8", errors="replace") as f:
                f.seek(ref["source_offset_bytes"])
                raw_line = f.readline()
            uin, sender_name = _sender_identity(raw_line)
        except OSError:
            pass

        if meta is None:
            role = ROLE_HUMAN
            msg_type = "unknown"
            has_media = False
            media_type = "none"
            text = ""
        else:
            role = ROLE_HUMAN
            if meta["is_system"]:
                role = ROLE_SYSTEM
            elif meta["is_bot"] or meta["bot_output_like"]:
                role = ROLE_BOT
            elif uin in KNOWN_BOT_UINS or BOT_NAME_RE.match(sender_name):
                role = ROLE_BOT
            msg_type = meta["message_type"]
            has_media = bool(meta["has_media"])
            media_type = meta["media_type"] or "none"
            text = meta["text_clean"] or ""
            sender_id_hash = meta["sender_id_hash"]

        lines.append(
            {
                "message_id": ref["message_id"],
                "sender_id_hash": sender_id_hash if meta is not None else "",
                "speaker_label": "?",
                "role": role,
                "message_type": msg_type,
                "has_media": has_media,
                "media_type": media_type,
                "bot_output_like": bool(meta["bot_output_like"]) if meta is not None else False,
                "text": text,
                "sender_name": sender_name,
                "review_only_bot_flag": role == ROLE_BOT,
            }
        )

    # map speaker labels from the window's speaker_ids order
    speaker_ids = window.get("speaker_ids") or []
    label_of = {sid: f"S{i + 1}" for i, sid in enumerate(speaker_ids)}
    used: set[int] = set()
    for mid in window.get("message_ids", []):
        for line in lines:
            if line["message_id"] == mid and id(line) not in used:
                line["speaker_label"] = label_of.get(line["sender_id_hash"], "?")
                used.add(id(line))
                break

    # per-line sanitization so the external review sheet never carries raw
    # nicknames, mentions, phone numbers or credential fragments.
    nick_of: dict[str, str] = {}
    for line in lines:
        if line.get("sender_name") and line["sender_id_hash"] in label_of:
            nick_of[line["sender_name"]] = label_of[line["sender_id_hash"]]
    for line in lines:
        text = line.get("text") or ""
        if text:
            sanitized, _, _, _ = sanitize_text(text, nick_of)
            line["text"] = sanitized
        # never export raw display names; S# labels already carry identity
        line.pop("sender_name", None)
    return lines


def render_annotated_lines(lines: list[dict[str, Any]]) -> str:
    """Render one line per message, e.g. ``S2[bot|text] 对啦``."""
    out: list[str] = []
    for l in lines:
        tags = [l["role"]]
        if l["message_type"]:
            tags.append(l["message_type"])
        if l["has_media"]:
            tags.append("media:" + (l["media_type"] or "unknown"))
        out.append(f"{l['speaker_label']}[{','.join(tags)}] {l['text']}".rstrip())
    return "\n".join(out)


def build_annotated_review(
    review_path: pathlib.Path,
    windows_path: pathlib.Path,
    messages_path: pathlib.Path,
    out_path: pathlib.Path,
    exports_root: pathlib.Path,
) -> int:
    windows = {w["window_id"]: w for w in pq.read_table(windows_path).to_pylist()}
    msg_index = _message_index(messages_path)
    records: list[dict[str, Any]] = []
    with review_path.open("r", encoding="utf-8") as f:
        for line in f:
            window = json.loads(line)
            full = windows.get(window["window_id"], {})
            window["speaker_ids"] = full.get("speaker_ids", [])
            lines = annotate_window(window, msg_index, exports_root)
            records.append(
                {
                    "window_id": window["window_id"],
                    "window_type": window["window_type"],
                    "split": window["split"],
                    "annotated_lines": lines,
                    "annotated_text": render_annotated_lines(lines),
                }
            )
    with out_path.open("w", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    return len(records)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="community-corpus-review-annotate")
    parser.add_argument("--review", type=pathlib.Path, default=pathlib.Path("reports/manual-review-v1.jsonl"))
    parser.add_argument("--windows", type=pathlib.Path, default=pathlib.Path("windows/v1/windows.parquet"))
    parser.add_argument("--messages", type=pathlib.Path, default=pathlib.Path("normalized/full/messages.parquet"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("reports/manual-review-v1-annotated.jsonl"))
    parser.add_argument("--exports-root", type=pathlib.Path, default=None)
    args = parser.parse_args(argv)
    exports_root = args.exports_root or pathlib.Path.home() / ".qq-chat-exporter" / "exports"
    n = build_annotated_review(
        args.review,
        args.windows,
        args.messages,
        args.output,
        exports_root,
    )
    print(f"[review-annotate] {n} windows -> {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
