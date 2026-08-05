"""Scan the normalized corpus for realistic Shadow A/B scenarios.

Each scenario = a real player osu!-flavored message in a group, with prior
context from the same group and (when available) the following bot text reply
as the "original" reference.

Output: reports/v2-eval/scenario-candidates.json (preview list, no secrets).
"""

from __future__ import annotations

import json
import pathlib
import re

import pyarrow.parquet as pq


OSU_HINT = re.compile(
    r"pp|acc|bp|串|跳|aim|dt|hd|hr|nc|fc|读图|rank|星|recent|miss|连击|"
    r"速度|难度|键|鼠标|键盘|图|打|成绩|记录|绑|查询|推图|推荐"
)


def main() -> None:
    parser = __import__("argparse").ArgumentParser()
    parser.add_argument(
        "--messages",
        type=pathlib.Path,
        default=pathlib.Path("normalized/full/messages.parquet"),
    )
    parser.add_argument(
        "--output",
        type=pathlib.Path,
        default=pathlib.Path("reports/v2-eval/scenario-candidates.json"),
    )
    parser.add_argument("--limit", type=int, default=40)
    args = parser.parse_args()

    table = pq.read_table(args.messages)
    rows = table.to_pylist()
    candidates: list[dict] = []
    seen: set[tuple[str, int]] = set()

    for i in range(len(rows) - 2):
        row = rows[i]
        if row["is_bot"] or row["bot_output_like"] or row["is_system"] or row["has_pii"]:
            continue
        text = (row["text_clean"] or "").strip()
        if not text or len(text) < 6 or len(text) > 120:
            continue
        if text.startswith(("[", "<", "/", "!", "~", "查", "绑定", "签到")):
            continue
        if not OSU_HINT.search(text):
            continue
        key = (row["group_id_hash"], row["timestamp"])
        if key in seen:
            continue

        context: list[dict] = []
        for j in range(i - 8, i):
            if j < 0 or rows[j]["group_id_hash"] != row["group_id_hash"]:
                continue
            c = rows[j]
            if c["is_bot"] or c["bot_output_like"] or c["is_system"] or c["has_pii"]:
                continue
            ctext = (c["text_clean"] or "").strip()
            if not ctext or ctext.startswith(("[", "<")):
                continue
            context.append({"timestamp": c["timestamp"], "text": ctext})
            if len(context) >= 8:
                break
        context.reverse()

        follow: dict | None = None
        for j in range(i + 1, min(i + 5, len(rows))):
            nxt = rows[j]
            if nxt["group_id_hash"] != row["group_id_hash"]:
                break
            if nxt["is_bot"] or nxt["bot_output_like"]:
                btext = (nxt["text_clean"] or "").strip()
                if len(btext) >= 10 and not nxt["has_pii"]:
                    follow = {"timestamp": nxt["timestamp"], "text": btext}
                    break
            else:
                ntext = (nxt["text_clean"] or "").strip()
                if ntext and not nxt["has_pii"]:
                    follow = {"timestamp": nxt["timestamp"], "text": ntext, "human": True}
                    break

        candidates.append(
            {
                "message_id": row["message_id"],
                "group_id_hash": row["group_id_hash"],
                "timestamp": row["timestamp"],
                "text": text,
                "context": context,
                "follow": follow,
            }
        )
        seen.add(key)
        if len(candidates) >= args.limit:
            break

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"wrote {len(candidates)} candidates -> {args.output}")


if __name__ == "__main__":
    main()
