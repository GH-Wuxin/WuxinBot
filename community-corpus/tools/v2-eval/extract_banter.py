"""Extract high-frequency low-nutrition reaction phrases from the corpus.

These are the short, content-free-but-real community reactions ("666",
"我跪了", "这也能活", "？") that make chat feel human. They are aggregated
by exact normalized text so the RAG prompt can use a compact static phrase
bank instead of retrieving hundreds of tiny windows.

Output: reports/v2-eval/banter-candidates.jsonl
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
from collections import Counter

import pyarrow.parquet as pq


_CMD_RE = re.compile(
    r"^\s*[!/！~～]\s*\S+"
    r"|^(?:查|查询|绑定|解绑|签到|早安|晚安|今日|汇率|推图|推荐)\S*"
)
_TOKEN_RE = re.compile(r"\b(?:sk-|ghp_|gho_|AKIA|eyJ)[A-Za-z0-9_\-]{8,}", re.I)
_URL_RE = re.compile(r"https?://|\.(?:com|cn|net|org|xyz|top)\b", re.I)
_PURE_DIGITS = re.compile(r"^\d{5,}$")
_PLACEHOLDER_RE = re.compile(
    r"\[(?:表情\d+|JSON消息|图片|视频|语音|文件|转发消息)|\[\[[^\]]+\]\]|<(?:MENTION|LOCATION|QQ_NUMBER|IMAGE|VIDEO|AUDIO)>"
)
_LEADING_PUNCT = re.compile(r"^[?？!！~～.。，,、:：|]+\s*\S")
_ASCII_WORD3 = re.compile(r"^[a-z]{3,}$")
_SINGLE_ASCII_LETTER = re.compile(r"^[A-Za-z]$")


def _reaction_like(text: str) -> bool:
    t = text.strip()
    if not t or len(t) > 8:
        return False
    if _CMD_RE.match(t):
        return False
    if _TOKEN_RE.search(t) or _URL_RE.search(t):
        return False
    if _PURE_DIGITS.match(t):
        return False
    if _PLACEHOLDER_RE.search(t):
        return False
    if _LEADING_PUNCT.match(t):
        return False
    if _ASCII_WORD3.match(t):
        return False
    if _SINGLE_ASCII_LETTER.match(t):
        return False
    if re.fullmatch(r"[\s\d\W_]+", t) and not re.search(r"[0-9A-Za-z\u4e00-\u9fa5]", t):
        return False
    return True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--messages",
        type=pathlib.Path,
        default=pathlib.Path("normalized/full/messages.parquet"),
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        default=pathlib.Path("reports/v2-eval/banter-candidates.jsonl"),
    )
    parser.add_argument("--min-count", type=int, default=3)
    parser.add_argument("--max-phrases", type=int, default=300)
    args = parser.parse_args()

    table = pq.read_table(
        args.messages,
        columns=[
            "text_clean",
            "is_bot",
            "is_system",
            "bot_output_like",
            "has_pii",
            "has_media",
            "message_type",
            "group_id_hash",
            "message_id",
        ],
    )
    counts: Counter[str] = Counter()
    sample_ids: dict[str, str] = {}
    sample_groups: dict[str, str] = {}
    total_hits = 0

    for row in table.to_pylist():
        if row["is_bot"] or row["is_system"] or row["bot_output_like"]:
            continue
        if row["has_pii"] or row["has_media"]:
            continue
        text = (row["text_clean"] or "").strip()
        if not _reaction_like(text):
            continue
        key = re.sub(r"\s+", " ", text)
        counts[key] += 1
        total_hits += 1
        if key not in sample_ids:
            sample_ids[key] = row["message_id"]
            sample_groups[key] = row["group_id_hash"]

    kept = [
        (text, n)
        for text, n in counts.items()
        if n >= args.min_count
    ]
    kept.sort(key=lambda x: (-x[1], x[0]))
    kept = kept[: args.max_phrases]

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for text, n in kept:
            f.write(
                json.dumps(
                    {
                        "text": text,
                        "count": n,
                        "sample_message_id": sample_ids[text],
                        "sample_group_id_hash": sample_groups[text],
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )

    print(f"total reaction hits: {total_hits}")
    print(f"distinct phrases: {len(counts)}")
    print(f"kept (count>={args.min_count}, top {args.max_phrases}): {len(kept)}")
    print(f"wrote -> {args.output}")
    print("top 40:")
    for text, n in kept[:40]:
        print(f"  {n:5d}  {text}")


if __name__ == "__main__":
    main()
