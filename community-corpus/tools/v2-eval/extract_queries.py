"""Extract real player messages from the V1 corpus as evaluation queries."""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re

import pyarrow.parquet as pq


IMG_RE = re.compile(r"^\[图片|^\[表情|^\[文件|^\[视频|^\[语音")
CMD_RE = re.compile(r"^\s*[!/~]|^查询|^查谱|^绑定|^签到|^早安|^晚安|^今日|^汇率")
OSU_KW_RE = re.compile(
    r"pp|acc|bp|串|图|dt|hr|hd|fc|手速|滑条|跳|aim|flow|speed|准|推|推荐|"
    r"打|mania|taiko|ctb|std|rank|星|难度|mod|replay|成绩|miss|连击|读图|"
    r"状态|手感|键盘|数位板|鼠标|练习|进步",
    re.IGNORECASE,
)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--messages", type=pathlib.Path, default=pathlib.Path("normalized/full/messages.parquet"))
    parser.add_argument("--output", type=pathlib.Path, default=pathlib.Path("reports/v2-eval/queries.jsonl"))
    parser.add_argument("--max", type=int, default=40)
    parser.add_argument("--min-days", type=int, default=0, help="only messages newer than N days ago")
    args = parser.parse_args()

    table = pq.read_table(
        args.messages,
        columns=["message_id", "text_clean", "is_bot", "bot_output_like", "has_media", "timestamp"],
    )
    now = datetime.datetime.now(datetime.timezone.utc)
    cands: list[tuple[datetime.datetime, str, str]] = []
    for r in table.to_pylist():
        txt = (r["text_clean"] or "").strip()
        if r["is_bot"] or r["bot_output_like"]:
            continue
        if r["has_media"] or IMG_RE.match(txt):
            continue
        if len(txt) < 5 or len(txt) > 90:
            continue
        if CMD_RE.match(txt):
            continue
        if not OSU_KW_RE.search(txt):
            continue
        if txt.startswith("[") or "<" in txt:
            continue
        ts = datetime.datetime.fromtimestamp(r["timestamp"] / 1000, datetime.timezone.utc)
        if args.min_days and (now - ts).days > args.min_days:
            continue
        cands.append((ts, r["message_id"], txt))
    cands.sort(reverse=True)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as f:
        for ts, mid, txt in cands[: args.max]:
            f.write(
                json.dumps(
                    {"message_id": mid, "timestamp": ts.isoformat(), "text": txt},
                    ensure_ascii=False,
                )
                + "\n"
            )
    print(f"wrote {min(len(cands), args.max)} queries -> {args.output}")


if __name__ == "__main__":
    main()
