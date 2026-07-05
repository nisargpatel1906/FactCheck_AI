from __future__ import annotations
import json
import asyncio
import logging
import httpx
import config
import api_keys

logger = logging.getLogger("backend.cache")

# Detect which backend to use at import time — avoids per-call branching overhead
_USE_POSTGRES = bool(config.DATABASE_URL)

# asyncpg connection pool (PostgreSQL only)
_pg_pool = None


# ── Shared utility ────────────────────────────────────────────────────────────

def _vec_literal(embedding: list[float]) -> str:
    """Format a float list as a pgvector text literal, e.g. '[0.1,0.2,...]'."""
    return f"[{','.join(str(v) for v in embedding)}]"


# ── PostgreSQL path ───────────────────────────────────────────────────────────

async def _get_pg_pool():
    global _pg_pool
    if _pg_pool is None:
        import asyncpg
        _pg_pool = await asyncpg.create_pool(config.DATABASE_URL, min_size=1, max_size=5)
    return _pg_pool


async def _pg_search(embedding: list[float]) -> dict | None:
    vec = _vec_literal(embedding)
    max_dist = 1.0 - config.SIMILARITY_THRESHOLD
    pool = await _get_pg_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(f"""
            SELECT id, claim_text, verdict, explanation, sources,
                   (embedding <=> '{vec}'::vector) AS distance
            FROM   claims
            WHERE  (embedding <=> '{vec}'::vector) < $1
            ORDER  BY embedding <=> '{vec}'::vector ASC
            LIMIT  1
        """, max_dist)
    if row:
        logger.info(f"Semantic Cache Hit! Distance: {row['distance']:.4f}")
        return {
            "claim_id":    f"claim_cached_{row['id']}",
            "claim_text":  row["claim_text"],
            "verdict":     row["verdict"],
            "explanation": row["explanation"],
            "sources":     json.loads(row["sources"]),
        }
    return None


async def _pg_store(claim_text: str, embedding: list[float],
                    verdict: str, explanation: str, sources: list) -> None:
    vec = _vec_literal(embedding)
    pool = await _get_pg_pool()
    async with pool.acquire() as conn:
        await conn.execute(f"""
            INSERT INTO claims (claim_text, verdict, explanation, sources, embedding)
            VALUES ($1, $2, $3, $4, '{vec}'::vector)
        """, claim_text, verdict, explanation, json.dumps(sources))
    logger.info(f"Cached claim in PostgreSQL: '{claim_text}'")


async def _pg_close() -> None:
    if _pg_pool:
        await _pg_pool.close()


# ── SQLite path (local dev fallback) ─────────────────────────────────────────

def _get_sqlite_conn():
    """Open a fresh SQLite connection with sqlite_vec loaded."""
    import sqlite3
    import sqlite_vec
    conn = sqlite3.connect(config.DATABASE_PATH)
    try:
        conn.enable_load_extension(True)
    except AttributeError:
        raise RuntimeError(
            "SQLite extension loading not supported.\n"
            "Fix: install Python from https://www.python.org/downloads/"
        )
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)
    return conn


def _sqlite_init() -> None:
    conn = _get_sqlite_conn()
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS claims (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            claim_text  TEXT NOT NULL,
            verdict     TEXT NOT NULL,
            explanation TEXT NOT NULL,
            sources     TEXT NOT NULL,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS claim_embeddings USING vec0(
            embedding float[1024] distance_metric=cosine
        )
    """)
    conn.commit()
    conn.close()
    logger.info(f"SQLite database initialised at: {config.DATABASE_PATH}")


def _sqlite_search(embedding: list[float]) -> dict | None:
    try:
        conn = _get_sqlite_conn()
        json_emb = json.dumps(embedding)
        max_dist = 1.0 - config.SIMILARITY_THRESHOLD
        row = conn.execute("""
            SELECT c.id, c.claim_text, c.verdict, c.explanation, c.sources, v.distance
            FROM   claim_embeddings v
            JOIN   claims c ON c.id = v.rowid
            WHERE  v.embedding MATCH ? AND k = 1 AND v.distance < ?
            ORDER  BY v.distance ASC
            LIMIT  1
        """, (json_emb, max_dist)).fetchone()
        conn.close()
        if row:
            logger.info(f"Semantic Cache Hit! Distance: {row[5]:.4f}")
            return {
                "claim_id":    f"claim_cached_{row[0]}",
                "claim_text":  row[1],
                "verdict":     row[2],
                "explanation": row[3],
                "sources":     json.loads(row[4]),
            }
        return None
    except Exception as e:
        logger.error(f"SQLite cache search failed: {e}")
        return None


def _sqlite_store(claim_text: str, embedding: list[float],
                  verdict: str, explanation: str, sources: list) -> None:
    try:
        conn = _get_sqlite_conn()
        cur = conn.cursor()
        cur.execute("""
            INSERT INTO claims (claim_text, verdict, explanation, sources)
            VALUES (?, ?, ?, ?)
        """, (claim_text, verdict, explanation, json.dumps(sources)))
        claim_id = cur.lastrowid
        cur.execute(
            "INSERT INTO claim_embeddings (rowid, embedding) VALUES (?, ?)",
            (claim_id, json.dumps(embedding))
        )
        conn.commit()
        conn.close()
        logger.info(f"Cached claim in SQLite: '{claim_text}'")
    except Exception as e:
        logger.error(f"SQLite cache store failed: {e}")


# ── Public API ────────────────────────────────────────────────────────────────

async def init_db() -> None:
    if not _USE_POSTGRES:
        await asyncio.to_thread(_sqlite_init)


async def close_db() -> None:
    if _USE_POSTGRES:
        await _pg_close()


async def get_embedding(text: str) -> list[float]:
    """
    Calls the NVIDIA NIM embedding API to generate a 1024-dim vector.
    Rotates through NVIDIA_API_KEY_1 … NVIDIA_API_KEY_8 on any failure.
    """
    if not api_keys.nvidia_keys:
        logger.error("No NVIDIA API keys configured. Cannot generate embedding.")
        return []

    for _ in range(len(api_keys.nvidia_keys)):
        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    f"{config.NVIDIA_BASE_URL}/embeddings",
                    headers={"Authorization": f"Bearer {api_keys.nvidia_keys.current}"},
                    json={
                        "input": [text],
                        "model": config.MODEL_EMBEDDING,
                        "input_type": "query",
                    },
                    timeout=10.0,
                )
            if response.status_code == 200:
                return response.json().get("data", [{}])[0].get("embedding", [])
            logger.error(
                f"NVIDIA Embeddings API error {response.status_code} "
                f"(key #{api_keys.nvidia_keys.active_index}): {response.text}"
            )
        except Exception as e:
            logger.error(
                f"NVIDIA Embeddings exception "
                f"(key #{api_keys.nvidia_keys.active_index}): {e}"
            )

        if not api_keys.nvidia_keys.rotate():
            break

    logger.error("Embedding generation failed on all NVIDIA API keys.")
    return []


async def search_cache_by_embedding(embedding: list[float]) -> dict | None:
    if not embedding:
        return None
    if _USE_POSTGRES:
        return await _pg_search(embedding)
    return await asyncio.to_thread(_sqlite_search, embedding)


async def store_verdict(claim_text: str, embedding: list[float] | None,
                        verdict: str, explanation: str, sources: list) -> None:
    if not embedding:
        embedding = await get_embedding(claim_text)
        if not embedding:
            logger.warning(f"Could not get embedding for '{claim_text}'. Skipping cache.")
            return
    if _USE_POSTGRES:
        await _pg_store(claim_text, embedding, verdict, explanation, sources)
    else:
        await asyncio.to_thread(_sqlite_store, claim_text, embedding, verdict, explanation, sources)
