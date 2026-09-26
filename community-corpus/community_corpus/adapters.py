"""Adapters for different raw chat export formats.

V0 ships with the QCE chunked-jsonl adapter. An adapter converts one raw line
into a normalized intermediate record; unknown message types are preserved as
``unknown`` instead of being dropped.
"""

from __future__ import annotations

import dataclasses
import json
from typing import Any, Optional


@dataclasses.dataclass(frozen=True)
class RawRecord:
    message_id: str
    seq: str
    timestamp_ms: int
    sender_uid: str
    sender_uin: str
    sender_name: str
    message_type: str
    text_raw: str
    reply_to_id: Optional[str]
    mentions: tuple[str, ...]  # uin or uid values
    media_types: tuple[str, ...]  # image/video/audio/file/...
    recalled: bool
    system: bool
    reply_sender_names: tuple[str, ...] = ()  # display names in reply previews


KNOWN_QCE_TYPES = {
    "text",
    "reply",
    "forward",
    "json",
    "video",
    "file",
    "audio",
    "image",
    "system",
}


class ParseError(Exception):
    """Raised when a raw line cannot be parsed."""


def repair_surrogates(value: str) -> str:
    """Replace lone surrogates (invalid in UTF-8) with U+FFFD.

    Valid surrogate pairs (e.g. JSON-escaped emoji) survive untouched;
    only unpaired surrogates are repaired so downstream UTF-8 storage
    (parquet) never fails.
    """
    if not value:
        return value
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        code = ord(value[i])
        if 0xD800 <= code <= 0xDBFF:
            if i + 1 < n and 0xDC00 <= ord(value[i + 1]) <= 0xDFFF:
                out.append(value[i : i + 2])
                i += 2
            else:
                out.append("\ufffd")
                i += 1
        elif 0xDC00 <= code <= 0xDFFF:
            out.append("\ufffd")
            i += 1
        else:
            out.append(value[i])
            i += 1
    return "".join(out)


def parse_qce_line(line: str) -> RawRecord:
    """Parse one QCE exported JSONL line into a RawRecord."""
    if not line or not line.strip():
        raise ParseError("empty line")
    try:
        m = json.loads(line)
    except json.JSONDecodeError as exc:
        raise ParseError(f"invalid json: {exc.msg}") from exc
    if not isinstance(m, dict):
        raise ParseError("line is not a json object")

    message_id = str(m.get("id") or m.get("seq") or "")
    if not message_id:
        raise ParseError("missing id/seq")
    seq = str(m.get("seq") or "")

    ts = m.get("timestamp")
    if ts is None:
        raise ParseError("missing timestamp")
    try:
        timestamp_ms = int(ts)
    except (TypeError, ValueError) as exc:
        raise ParseError(f"invalid timestamp: {ts!r}") from exc
    if timestamp_ms < 1e12 and timestamp_ms > 1e9:
        timestamp_ms *= 1000

    sender = m.get("sender") or {}
    sender_uid = str(sender.get("uid") or "")
    sender_uin = str(sender.get("uin") or "")
    sender_name = str(sender.get("groupCard") or sender.get("name") or sender.get("nick") or "")

    msg_type = str(m.get("type") or "unknown")
    if msg_type not in KNOWN_QCE_TYPES:
        msg_type = "unknown"

    content = m.get("content") or {}
    text_raw = str(content.get("text") or "")

    # Reply reference: QCE puts the referenced id in the reply element.
    reply_to_id: Optional[str] = None
    reply_sender_names: list[str] = []
    elements = content.get("elements") or []
    for el in elements:
        if isinstance(el, dict) and el.get("type") == "reply":
            data = el.get("data") or {}
            ref = data.get("referencedMessageId") or data.get("messageId")
            if ref:
                reply_to_id = str(ref)
            name = data.get("senderName")
            if name:
                reply_sender_names.append(str(name))
            break

    mentions: list[str] = []
    for mention in content.get("mentions") or []:
        if isinstance(mention, dict):
            value = str(mention.get("uin") or mention.get("uid") or "")
            if value:
                mentions.append(value)

    media_types: list[str] = []
    for res in content.get("resources") or []:
        if isinstance(res, dict) and res.get("type"):
            t = str(res["type"])
            if t not in media_types:
                media_types.append(t)

    return RawRecord(
        message_id=repair_surrogates(message_id),
        seq=repair_surrogates(seq),
        timestamp_ms=timestamp_ms,
        sender_uid=repair_surrogates(sender_uid),
        sender_uin=repair_surrogates(sender_uin),
        sender_name=repair_surrogates(sender_name),
        message_type=repair_surrogates(msg_type),
        text_raw=repair_surrogates(text_raw),
        reply_to_id=repair_surrogates(reply_to_id) if reply_to_id else None,
        mentions=tuple(repair_surrogates(m) for m in mentions),
        reply_sender_names=tuple(repair_surrogates(n) for n in reply_sender_names),
        media_types=tuple(media_types),
        recalled=bool(m.get("recalled")),
        system=bool(m.get("system")) or msg_type == "system",
    )


def clean_text(raw: str, reply_sender_names: Optional[list[str]] = None) -> str:
    """Remove media placeholders, reply prefixes and leading @mentions.

    ``reply_sender_names`` are display names carried by QCE reply elements.
    When present, the full ``@<name>`` span is stripped from the reply
    preview so a sender's nickname cannot survive in ``text_clean``.
    """
    import re

    text = raw.replace("\r\n", "\n").replace("\x00", "")
    text = re.sub(r"\[(图片|动画表情|表情|视频|语音|文件|链接)[：:][^\]]*\]", "", text)
    if reply_sender_names:
        for name in sorted(set(reply_sender_names), key=len, reverse=True):
            if not name:
                continue
            pattern = r"^\[回复消息\]\s*@?\s*" + re.escape(name) + r"\s*"
            text = re.sub(pattern, "", text)
    text = re.sub(r"^\[回复消息\](?:\s*@[^\s]+\s*)?", "", text)
    text = re.sub(r"^@[^\s]+\s*", "", text)
    return text.strip()
