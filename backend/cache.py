import json
import sqlite3
import logging
import asyncio
import httpx
import sqlite_vec
import config

logger = logging.getLogger("backend.cache")

def init_db():
    """
    Initializes the SQLite database and loads the sqlite-vec extension.
    Creates necessary tables if they do not exist.
    """
    try:
        conn = sqlite3.connect(config.DATABASE_PATH)
        # Enable WAL mode for concurrency
        conn.execute("PRAGMA journal_mode=WAL;")
        
        # Enable extension loading and load the sqlite-vec extension
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        
        cursor = conn.cursor()
        
        # 1. Create traditional metadata table
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                claim_text TEXT NOT NULL,
                verdict TEXT NOT NULL,
                explanation TEXT NOT NULL,
                sources TEXT NOT NULL, -- Stored as JSON array string
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        """)
        
        # 2. Create sqlite-vec virtual table for fast cosine similarity search
        # Dimension is 1024 for nvidia/embeddings-nv-embed-qa-4
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS claim_embeddings USING vec0(
                embedding float[1024] distance_metric=cosine
            )
        """)
        
        conn.commit()
        conn.close()
        logger.info(f"Database initialized successfully at: {config.DATABASE_PATH}")
    except Exception as e:
        logger.error(f"Failed to initialize database: {e}")

async def get_embedding(text: str) -> list[float]:
    """
    Calls the NVIDIA NIM embedding API catalog endpoint to generate a vector for the input text.
    """
    if not config.NVIDIA_API_KEY:
        logger.error("NVIDIA_API_KEY is not set. Cannot generate embedding.")
        return []

    try:
        url = f"{config.NVIDIA_BASE_URL}/embeddings"
        headers = {
            "Authorization": f"Bearer {config.NVIDIA_API_KEY}",
            "Content-Type": "application/json"
        }
        payload = {
            "input": [text],
            "model": config.MODEL_EMBEDDING,
            "input_type": "query"
        }

        async with httpx.AsyncClient() as client:
            response = await client.post(url, headers=headers, json=payload, timeout=10.0)

        if response.status_code != 200:
            logger.error(f"NVIDIA Embeddings API error {response.status_code}: {response.text}")
            return []

        result = response.json()
        embedding = result.get("data", [{}])[0].get("embedding", [])
        return embedding
    except Exception as e:
        logger.error(f"Failed to retrieve text embedding: {e}")
        return []

def _sync_search_cache(embedding: list[float]) -> dict | None:
    """
    Synchronous helper for database semantic matching. Runs inside an executor.
    """
    try:
        conn = sqlite3.connect(config.DATABASE_PATH)
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        cursor = conn.cursor()
        
        # Convert float list to JSON array string for MATCH operator
        json_emb = json.dumps(embedding)
        max_distance = 1.0 - config.SIMILARITY_THRESHOLD
        
        # Search the vec0 table and join with metadata table
        cursor.execute("""
            SELECT 
                c.id, 
                c.claim_text, 
                c.verdict, 
                c.explanation, 
                c.sources, 
                v.distance
            FROM claim_embeddings v
            JOIN claims c ON c.id = v.rowid
            WHERE v.embedding MATCH ? AND k = 1 AND v.distance < ?
            ORDER BY v.distance ASC
            LIMIT 1
        """, (json_emb, max_distance))
        
        row = cursor.fetchone()
        conn.close()
        
        if row:
            logger.info(f"Semantic Cache Hit! Distance: {row[5]:.4f} (Similarity: {1.0 - row[5]:.4f})")
            return {
                "claim_id": f"claim_cached_{row[0]}",
                "claim_text": row[1],
                "verdict": row[2],
                "explanation": row[3],
                "sources": json.loads(row[4])
            }
        return None
    except Exception as e:
        logger.error(f"Synchronous cache search failed: {e}")
        return None

async def search_cache_by_embedding(embedding: list[float]) -> dict | None:
    """
    Searches the SQLite cache using a pre-computed embedding vector.
    Returns the cached claim dictionary if a match above the similarity threshold is found, else None.
    """
    if not embedding:
        return None
    return await asyncio.to_thread(_sync_search_cache, embedding)

async def search_cache(claim_text: str) -> dict | None:
    """
    Searches the SQLite cache for a semantically similar claim (> similarity threshold).
    Returns the cached claim dictionary if found, else None.
    """
    embedding = await get_embedding(claim_text)
    return await search_cache_by_embedding(embedding)

def _sync_store_verdict(claim_text: str, embedding: list[float], verdict: str, explanation: str, sources: list) -> None:
    """
    Synchronous helper to store verdict metadata and embedding in SQLite. Runs in executor.
    """
    try:
        conn = sqlite3.connect(config.DATABASE_PATH)
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        cursor = conn.cursor()
        
        # 1. Insert into metadata table
        cursor.execute("""
            INSERT INTO claims (claim_text, verdict, explanation, sources)
            VALUES (?, ?, ?, ?)
        """, (claim_text, verdict, explanation, json.dumps(sources)))
        
        claim_id = cursor.lastrowid
        
        # 2. Insert vector into vec0 table matching rowid
        json_emb = json.dumps(embedding)
        cursor.execute("""
            INSERT INTO claim_embeddings (rowid, embedding)
            VALUES (?, ?)
        """, (claim_id, json_emb))
        
        conn.commit()
        conn.close()
        logger.info(f"Successfully cached claim '{claim_text}' with ID: {claim_id}")
    except Exception as e:
        logger.error(f"Synchronous cache store failed: {e}")

async def store_verdict(claim_text: str, embedding: list[float] | None, verdict: str, explanation: str, sources: list) -> None:
    """
    Asynchronously stores a newly generated claim verdict and its embedding vector.
    """
    # If embedding is not provided, fetch it now
    if not embedding:
        embedding = await get_embedding(claim_text)
        if not embedding:
            logger.warning(f"Could not retrieve embedding for storing claim: '{claim_text}'. Skipping caching.")
            return

    await asyncio.to_thread(_sync_store_verdict, claim_text, embedding, verdict, explanation, sources)
