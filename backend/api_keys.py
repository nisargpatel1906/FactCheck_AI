"""
API key rotation pool.

Loads up to 8 numbered keys per provider from the environment:
  NVIDIA_API_KEY_1 ... NVIDIA_API_KEY_8
  TAVILY_API_KEY_1 ... TAVILY_API_KEY_8
  GROQ_API_KEY_1   ... GROQ_API_KEY_8

Falls back to the un-numbered var (e.g. NVIDIA_API_KEY) if no numbered
keys are present — so single-key local dev still works with no .env changes.

On any API failure the caller calls pool.rotate(), which advances to the
next key. When all keys are exhausted, rotate() returns False and the
caller should return a graceful error result.
"""
from __future__ import annotations

import os
import threading
import logging
from pathlib import Path
from dotenv import load_dotenv

# Ensure .env is loaded (idempotent — safe to call multiple times)
load_dotenv(Path(__file__).resolve().parent / ".env")

logger = logging.getLogger("backend.api_keys")


class KeyPool:
    """Thread-safe rotating pool of API keys for a single provider."""

    def __init__(self, keys: list[str], name: str) -> None:
        self._keys = [k for k in keys if k]   # drop blanks
        self._index = 0
        self._name = name
        self._lock = threading.Lock()          # guards _index across to_thread calls

    # ── Public interface ──────────────────────────────────────────────────────

    @property
    def current(self) -> str:
        """Return the currently active API key (empty string if pool is empty)."""
        return self._keys[self._index] if self._keys else ""

    @property
    def active_index(self) -> int:
        """1-based index of the current key (for logging)."""
        return self._index + 1

    def rotate(self) -> bool:
        """
        Advance to the next key after a failure.

        Returns True  — a fresh key is now active, caller should retry.
        Returns False — all keys are exhausted, caller should give up.
        """
        with self._lock:
            if self._index < len(self._keys) - 1:
                self._index += 1
                logger.warning(
                    f"[{self._name}] API failure — rotating to key "
                    f"#{self._index + 1}/{len(self._keys)}"
                )
                return True
            logger.error(
                f"[{self._name}] All {len(self._keys)} key(s) exhausted. "
                "Returning graceful error."
            )
            return False

    def __len__(self) -> int:
        return len(self._keys)

    def __bool__(self) -> bool:
        return bool(self._keys)

    def __repr__(self) -> str:
        return f"KeyPool({self._name!r}, {len(self._keys)} keys, active=#{self._index + 1})"


# ── Loader ────────────────────────────────────────────────────────────────────

def _load(prefix: str, single_var: str) -> KeyPool:
    """
    Try NVIDIA_API_KEY_1 … NVIDIA_API_KEY_8 first.
    Fall back to NVIDIA_API_KEY (single legacy var) if none are set.
    """
    keys = [
        os.getenv(f"{prefix}_{i}", "").strip()
        for i in range(1, 9)
    ]
    keys = [k for k in keys if k]

    if not keys:
        fallback = os.getenv(single_var, "").strip()
        if fallback:
            keys = [fallback]

    pool = KeyPool(keys, prefix)
    logger.info(f"[{prefix}] Loaded {len(pool)} API key(s).")
    return pool


# ── Module-level pools (import these in callers) ──────────────────────────────

nvidia_keys = _load("NVIDIA_API_KEY", "NVIDIA_API_KEY")
tavily_keys = _load("TAVILY_API_KEY", "TAVILY_API_KEY")
groq_keys   = _load("GROQ_API_KEY",   "GROQ_API_KEY")


# ── Self-check ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(nvidia_keys)
    print(tavily_keys)
    print(groq_keys)

    # Simulate rotation
    print("\nSimulating NVIDIA rotation:")
    print(f"  Active: {nvidia_keys.current!r}")
    while nvidia_keys.rotate():
        print(f"  Active: {nvidia_keys.current!r}")
    print("  Exhausted.")
