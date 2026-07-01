import logging
import uuid
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import config
import stt
import claim_detection
import cache
import queue_manager
from session import SessionState

import os
from logging.handlers import RotatingFileHandler

# Set up logging configuration
log_dir = "logs"
os.makedirs(log_dir, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[
        RotatingFileHandler(os.path.join(log_dir, "server.log"), maxBytes=5*1024*1024, backupCount=3),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger("backend")

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize cache database on startup
    cache.init_db()
    
    # Start pipeline queue workers
    queue_manager.start_workers()
    
    yield
    
    # Clean up pipeline queue workers on shutdown
    await queue_manager.stop_workers()

app = FastAPI(title="FactCheck AI Backend", lifespan=lifespan)

async def transcript_buffer_loop(session: SessionState, websocket: WebSocket):
    logger.info(f"Starting transcript buffer loop for session {session.session_id}")
    try:
        while session.active:
            # Wake up every N seconds (e.g. 20s)
            await asyncio.sleep(config.CLAIM_DETECTION_WINDOW_SECONDS)
            window_text = await session.pop_buffer()
            if not window_text.strip():
                continue
            
            logger.info(f"Checking transcript buffer window: '{window_text}'")
            claims = await claim_detection.detect_claims(window_text)
            
            for claim_text in claims:
                claim_id = f"claim_{uuid.uuid4().hex[:8]}"
                logger.info(f"Factual claim detected: '{claim_text}' (ID: {claim_id})")
                
                # Check Semantic Cache — get embedding first, reuse for both cache lookup and queue
                embedding = await cache.get_embedding(claim_text)
                if not embedding:
                    logger.warning(f"Could not get embedding for claim '{claim_text}'. Skipping.")
                    continue

                cached = await cache.search_cache_by_embedding(embedding)
                if cached:
                    logger.info(f"Cache Hit! Returning cached verdict for: '{claim_text}'")
                    verdict_msg = {
                        "type": "verdict_update",
                        "claim_id": claim_id,
                        "claim_text": claim_text,
                        "verdict": cached["verdict"],
                        "explanation": cached["explanation"],
                        "sources": cached["sources"],
                        "cached": True
                    }
                    await websocket.send_json(verdict_msg)
                    continue

                # Cache Miss - Send checking status update
                status_msg = {
                    "type": "status_update",
                    "claim_id": claim_id,
                    "claim_text": claim_text,
                    "status": "checking"
                }
                await websocket.send_json(status_msg)
                
                # Enqueue the claim into the multi-agent processing pipeline
                await queue_manager.enqueue_claim(
                    claim_id=claim_id,
                    claim_text=claim_text,
                    embedding=embedding,
                    websocket=websocket,
                    session=session
                )
                
    except asyncio.CancelledError:
        logger.info(f"Transcript buffer loop cancelled for session {session.session_id}")
    except Exception as e:
        logger.error(f"Error in transcript buffer loop: {e}")

@app.get("/")
def read_root():
    return {"message": "FactCheck AI Backend is running"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session_id = str(uuid.uuid4())
    session = SessionState(session_id=session_id)
    logger.info(f"WebSocket connection accepted. Session ID: {session_id}")
    
    # Spawn background task to process accumulated transcript buffers
    loop_task = asyncio.create_task(transcript_buffer_loop(session, websocket))
    
    try:
        while True:
            data = await websocket.receive_json()
            msg_type = data.get("type")
            
            if msg_type == "keepalive":
                logger.info("Received keepalive from client.")
            elif msg_type == "caption_chunk":
                text = data.get("text", "")
                timestamp = data.get("timestamp_ms")
                logger.info(f"Received caption chunk at {timestamp}: '{text}'")
                await session.append_text(text)
            elif msg_type == "audio_chunk":
                audio_base64 = data.get("audio_base64", "")
                fmt = data.get("format", "")
                timestamp = data.get("timestamp_ms")
                logger.info(f"Received audio chunk at {timestamp}: base64 len={len(audio_base64)}, format={fmt}")
                
                # Perform transcription
                transcribed_text = await stt.transcribe_audio(audio_base64)
                if transcribed_text:
                    logger.info(f"Transcribed audio chunk to: '{transcribed_text}'")
                    await session.append_text(transcribed_text)
                    await websocket.send_json({
                        "type": "transcription",
                        "text": transcribed_text
                    })
                else:
                    logger.info("Audio chunk transcription resolved to empty text.")
            elif msg_type == "manual_claim":
                text = data.get("text", "").strip()
                if not text:
                    continue
                claim_id = f"manual_{uuid.uuid4().hex[:8]}"
                logger.info(f"Manual claim submitted: '{text}' (ID: {claim_id})")
            
                embedding = await cache.get_embedding(text)
                if not embedding:
                    continue
            
                cached = await cache.search_cache_by_embedding(embedding)
                if cached:
                    await websocket.send_json({
                        "type": "verdict_update",
                        "claim_id": claim_id,
                        "claim_text": text,
                        "verdict": cached["verdict"],
                        "explanation": cached["explanation"],
                        "sources": cached["sources"],
                        "cached": True
                    })
                    continue
            
                await websocket.send_json({
                    "type": "status_update",
                    "claim_id": claim_id,
                    "claim_text": text,
                    "status": "checking"
                })
                await queue_manager.enqueue_claim(
                    claim_id=claim_id,
                    claim_text=text,
                    embedding=embedding,
                    websocket=websocket,
                    session=session
                )
            else:
                logger.info(f"Received generic message: {data}")
            
    except WebSocketDisconnect:
        logger.info(f"WebSocket session {session_id} disconnected gracefully.")
    except Exception as e:
        logger.error(f"WebSocket error encountered on session {session_id}: {e}")
    finally:
        await session.close()
        loop_task.cancel()
        try:
            await loop_task
        except asyncio.CancelledError:
            pass
