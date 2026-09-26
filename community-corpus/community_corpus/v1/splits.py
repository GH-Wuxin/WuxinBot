"""Task 5: deterministic time-block partitioning.

Per group, sessions are ordered by start time and split into contiguous
blocks: first 70% -> train_candidate, next 15% -> review_candidate,
last 15% -> eval_holdout. Windows inherit their session's split, so a
session (and heavily overlapping windows) can never cross splits.
"""

from __future__ import annotations

import collections
from typing import Any


TRAIN = "train_candidate"
REVIEW = "review_candidate"
EVAL = "eval_holdout"

TRAIN_RATIO = 0.70
REVIEW_RATIO = 0.15


def session_splits(sessions: list[dict[str, Any]], seed: int) -> dict[str, str]:
    by_group: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
    for s in sessions:
        by_group[s["group_id_hash"]].append(s)

    result: dict[str, str] = {}
    for group_hash, group_sessions in sorted(by_group.items()):
        ordered = sorted(group_sessions, key=lambda s: (s["start_timestamp"], s["session_id"]))
        n = len(ordered)
        train_end = max(1, int(round(n * TRAIN_RATIO)))
        review_end = train_end + max(0, int(round(n * REVIEW_RATIO)))
        for i, s in enumerate(ordered):
            if i < train_end:
                split = TRAIN
            elif i < review_end:
                split = REVIEW
            else:
                split = EVAL
            result[s["session_id"]] = split
    return result


def apply_splits(windows: list[dict[str, Any]], splits: dict[str, str]) -> None:
    for w in windows:
        w["split"] = splits.get(w["session_id"], TRAIN)
