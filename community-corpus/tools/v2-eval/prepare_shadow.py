"""Prepare Shadow A/B scenarios for the V2 community-corpus test.

Selects 6 fixed, real osu! player messages from the normalized corpus, keeps
their real preceding context, and attaches the top BM25-approved style windows
for each scenario query. No randomness; deterministic selection by exact text.

Output: reports/v2-eval/shadow-scenarios.json
"""

from __future__ import annotations

import json
import math
import pathlib
from collections import Counter

from community_corpus.v1.windows import _tokens


SCENARIO_TEXT = [
    "我草，我真的有朝一日fc了疯机器！",
    "滚，dt毁歌",
    "这玩意真的是pp图吗...",
    "这下没有1miss了 变成acc爆炸了",
    "难的到底是ar10还是270跳....",
    "我打着打着感觉光标卡是咋回事",
]


def _bm25(docs, query_tokens, k1=1.2, b=0.75, limit=4):
    avg_len = sum(len(toks) for _, toks in docs) / max(1, len(docs))
    doc_freq: Counter[str] = Counter()
    for _, toks in docs:
        for tok in set(toks):
            doc_freq[tok] += 1
    n = len(docs)
    scored = []
    for doc_id, toks in docs:
        tf = Counter(toks)
        score = 0.0
        for tok in query_tokens:
            f = tf.get(tok, 0)
            if not f:
                continue
            df = doc_freq.get(tok, 0)
            idf = math.log(1 + (n - df + 0.5) / (df + 0.5))
            denom = f + k1 * (1 - b + b * len(toks) / avg_len)
            score += idf * (f * (k1 + 1)) / denom
        scored.append((doc_id, score))
    scored.sort(key=lambda x: x[1], reverse=True)
    return scored[:limit]


def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[2]
    cands_path = root / "reports/v2-eval/scenario-candidates.json"
    approved_path = root / "reports/V2-style-ready-candidates.jsonl"
    output_path = root / "reports/v2-eval/shadow-scenarios.json"

    candidates = json.loads(cands_path.read_text(encoding="utf-8"))
    approved = [
        json.loads(line)
        for line in approved_path.read_text(encoding="utf-8").splitlines()
        if json.loads(line).get("approved")
    ]
    docs = [(r["window_id"], list(_tokens(r["text_sanitized"]))) for r in approved]
    by_text = {c["text"].strip(): c for c in candidates}

    scenarios = []
    for text in SCENARIO_TEXT:
        cand = by_text.get(text)
        if cand is None:
            raise SystemExit(f"scenario not found: {text}")
        context_text = "\n".join(c["text"] for c in cand["context"])
        variants = {
            "text_only": text,
            "text_plus_context": text + "\n" + context_text,
        }
        retrieved = {}
        for variant, query in variants.items():
            ranked = _bm25(docs, _tokens(query))
            windows = []
            for window_id, score in ranked:
                rec = next(r for r in approved if r["window_id"] == window_id)
                windows.append(
                    {
                        "window_id": window_id,
                        "score": round(score, 4),
                        "text": rec["text_sanitized"],
                    }
                )
            retrieved[variant] = {"query": query, "windows": windows}
        scenarios.append(
            {
                "id": f"scenario_{len(scenarios):02d}",
                "player_text": text,
                "context": cand["context"],
                "follow": cand["follow"],
                "retrieved": retrieved,
            }
        )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(
            {
                "index_size": len(approved),
                "scenarios": scenarios,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    print(f"wrote {len(scenarios)} scenarios -> {output_path}")


if __name__ == "__main__":
    main()
