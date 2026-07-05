"""
One-shot migration: SQLite (factcheck.db) → PostgreSQL

Steps:
  1. Add DATABASE_URL to backend/.env  (get it from Railway → PostgreSQL → Variables)
  2. Activate your virtual environment
  3. Run:  python migrate.py

The script is idempotent — it skips rows that already exist in PostgreSQL.
"""
import asyncio
import json
import sqlite3
import sys
from pathlib import Path

import asyncpg

# Load config (reads backend/.env automatically)
sys.path.insert(0, str(Path(__file__).parent))
import config

SQLITE_PATH = config.DATABASE_PATH
PG_URL      = config.DATABASE_URL


async def migrate() -> None:
    if not PG_URL:
        print("ERROR: DATABASE_URL is not set.")
        print("Add it to backend/.env — get the value from Railway → PostgreSQL → Variables tab.")
        sys.exit(1)

    # ── 1. Connect to PostgreSQL and ensure schema ────────────────────────────
    print(f"\n[1/3] Connecting to PostgreSQL...")
    pool = await asyncpg.create_pool(PG_URL)

    async with pool.acquire() as conn:
        await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS claims (
                id          BIGSERIAL PRIMARY KEY,
                claim_text  TEXT NOT NULL,
                verdict     TEXT NOT NULL,
                explanation TEXT NOT NULL,
                sources     TEXT NOT NULL,
                embedding   vector(1024) NOT NULL,
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        await conn.execute("""
            CREATE TABLE IF NOT EXISTS rate_limits (
                device_id   TEXT NOT NULL,
                date_str    TEXT NOT NULL,
                check_count INTEGER DEFAULT 1,
                PRIMARY KEY (device_id, date_str)
            )
        """)
        await conn.execute("""
            CREATE INDEX IF NOT EXISTS claims_embedding_hnsw
            ON claims USING hnsw (embedding vector_cosine_ops)
        """)
    print("PostgreSQL schema ready.")

    # ── 2. Read from SQLite ───────────────────────────────────────────────────
    print(f"\n[2/3] Reading from SQLite: {SQLITE_PATH}")

    if not Path(SQLITE_PATH).exists():
        print("NOTICE: factcheck.db not found. Schema initialized, but no old data to migrate.")
        await pool.close()
        return

    sqlite_conn = sqlite3.connect(SQLITE_PATH)

    # Try to load sqlite_vec so we can read the embeddings
    has_vec = False
    try:
        import sqlite_vec
        sqlite_conn.enable_load_extension(True)
        sqlite_vec.load(sqlite_conn)
        sqlite_conn.enable_load_extension(False)
        has_vec = True
    except Exception as e:
        print(f"WARNING: Could not load sqlite_vec ({e}).")
        print("         Rows without embeddings will be skipped (they can't be used for semantic cache).")

    rows = sqlite_conn.execute(
        "SELECT id, claim_text, verdict, explanation, sources FROM claims"
    ).fetchall()
    print(f"Found {len(rows)} claim(s) in SQLite.")

    if not rows:
        print("Nothing to migrate. Exiting.")
        sqlite_conn.close()
        return

    # Build embedding map: { sqlite_id: [float, ...] }
    embeddings: dict[int, list[float]] = {}
    if has_vec:
        for row_id, *_ in rows:
            emb_row = sqlite_conn.execute(
                "SELECT embedding FROM claim_embeddings WHERE rowid = ?", (row_id,)
            ).fetchone()
            if emb_row:
                embeddings[row_id] = json.loads(emb_row[0])

    sqlite_conn.close()
    print(f"Embeddings available for {len(embeddings)} / {len(rows)} claim(s).")



    # ── 3. Insert rows ────────────────────────────────────────────────────────
    print(f"\n[3/3] Migrating claims...")
    inserted = skipped_no_emb = skipped_dup = 0

    async with pool.acquire() as conn:
        for row_id, claim_text, verdict, explanation, sources in rows:
            emb = embeddings.get(row_id)

            if emb is None:
                print(f"  SKIP (no embedding): {claim_text[:70]!r}")
                skipped_no_emb += 1
                continue

            # Idempotency: skip if claim text already in PostgreSQL
            exists = await conn.fetchval(
                "SELECT 1 FROM claims WHERE claim_text = $1 LIMIT 1", claim_text
            )
            if exists:
                print(f"  SKIP (already exists): {claim_text[:70]!r}")
                skipped_dup += 1
                continue

            vec_literal = f"[{','.join(str(v) for v in emb)}]"
            await conn.execute(f"""
                INSERT INTO claims (claim_text, verdict, explanation, sources, embedding)
                VALUES ($1, $2, $3, $4, '{vec_literal}'::vector)
            """, claim_text, verdict, explanation, sources)

            inserted += 1
            print(f"  [{inserted:>3}] Migrated: {claim_text[:70]!r}")

    await pool.close()

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"""
Migration complete.
  Inserted : {inserted}
  Skipped (no embedding) : {skipped_no_emb}
  Skipped (duplicate)    : {skipped_dup}
  Total SQLite rows      : {len(rows)}
""")


if __name__ == "__main__":
    asyncio.run(migrate())
