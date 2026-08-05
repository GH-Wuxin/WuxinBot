"""Pipeline configuration."""

from __future__ import annotations

import dataclasses
import os
import pathlib
import secrets


PROJECT_ROOT = pathlib.Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT_DIR = PROJECT_ROOT
DEFAULT_SALT_FILE = PROJECT_ROOT / ".salt"
DEFAULT_SAMPLE_SIZE = 50_000
DEFAULT_SEED = 20260805


@dataclasses.dataclass(frozen=True)
class Config:
    sources: tuple[str, ...]
    sample_size: int
    seed: int
    salt: str
    output_dir: pathlib.Path

    @property
    def raw_dir(self) -> pathlib.Path:
        return self.output_dir / "raw"

    @property
    def normalized_dir(self) -> pathlib.Path:
        return self.output_dir / "normalized"

    @property
    def reports_dir(self) -> pathlib.Path:
        return self.output_dir / "reports"


def load_or_create_salt(salt_file: pathlib.Path | None = None) -> str:
    """Read the secret salt, creating a random one on first run.

    A fixed salt file guarantees deterministic anonymization across runs.
    """
    path = salt_file or pathlib.Path(os.environ.get("COMMUNITY_CORPUS_SALT", DEFAULT_SALT_FILE))
    if path.exists():
        value = path.read_text(encoding="utf-8").strip()
        if value:
            return value
    value = secrets.token_hex(32)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value + "\n", encoding="utf-8")
    return value


def build_config(
    *,
    sources: list[str] | tuple[str, ...],
    sample_size: int = DEFAULT_SAMPLE_SIZE,
    seed: int = DEFAULT_SEED,
    salt: str | None = None,
    output_dir: str | pathlib.Path | None = None,
    salt_file: pathlib.Path | None = None,
) -> Config:
    if not 30_000 <= sample_size <= 50_000:
        raise ValueError("sample_size must be in [30000, 50000]")
    if len(sources) == 0:
        raise ValueError("at least one source export directory is required")
    return Config(
        sources=tuple(sources),
        sample_size=sample_size,
        seed=seed,
        salt=salt or load_or_create_salt(salt_file),
        output_dir=pathlib.Path(output_dir or DEFAULT_OUTPUT_DIR),
    )
