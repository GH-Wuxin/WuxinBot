"""Read sender names from original QCE exports by byte offset."""

from __future__ import annotations

import collections
import pathlib
from typing import Any, Iterable

from ..adapters import ParseError, parse_qce_line


def load_sender_names(
    export_dirs: list[pathlib.Path],
    refs: Iterable[tuple[str, str, int]],
) -> dict[str, str]:
    """Given (source_export, source_file, byte_offset) refs, return
    {message_id: sender_name} for the referenced lines.
    """
    export_by_name = {p.name: p for p in export_dirs}
    needed: dict[tuple[str, str], list[int]] = collections.defaultdict(list)
    for export_name, chunk_rel, byte_offset in refs:
        needed[(export_name, chunk_rel)].append(byte_offset)

    result: dict[str, str] = {}
    for (export_name, chunk_rel), offsets in needed.items():
        export_dir = export_by_name.get(export_name)
        if export_dir is None:
            continue
        chunk_path = export_dir / chunk_rel
        if not chunk_path.exists():
            continue
        offsets = sorted(set(offsets))
        with chunk_path.open("r", encoding="utf-8", newline="") as f:
            for off in offsets:
                f.seek(off)
                line = f.readline()
                if not line:
                    continue
                try:
                    rec = parse_qce_line(line)
                except ParseError:
                    continue
                result[rec.message_id] = rec.sender_name
    return result
