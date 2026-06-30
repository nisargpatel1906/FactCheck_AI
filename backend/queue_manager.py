import logging
import asyncio
from fastapi import WebSocket
from session import SessionState
from agents.research_agent import run_research
from agents.debate import run_debate_round
from agents.judge import run_judge
from schemas import ResearchDraft, JudgeVerdict
import cache
import config

logger = logging.getLogger("backend.queue_manager")

# Global task queue
pipeline_queue = asyncio.Queue()
worker_tasks = []

async def enqueue_claim(
    claim_id: str,
    claim_text: str,
    embedding: list[float],
    websocket: WebSocket,
    session: SessionState
):
    """
    Enqueues a claim to be processed by the worker pool.
    """
    await pipeline_queue.put((claim_id, claim_text, embedding, websocket, session))
    logger.info(f"Enqueued claim: '{claim_text}' (ID: {claim_id}). Queue size: {pipeline_queue.qsize()}")

async def worker_loop(worker_id: int):
    """
    Worker task pulling claims from queue and running the multi-agent pipeline.
    """
    logger.info(f"Starting pipeline worker {worker_id}")
    try:
        while True:
            # Pull job from queue
            claim_id, claim_text, embedding, websocket, session = await pipeline_queue.get()
            logger.info(f"Worker {worker_id} - Processing claim: '{claim_text}'")
            
            try:
                # Helper function to send websocket updates safely
                async def safe_send(msg: dict):
                    if session.active:
                        try:
                            await websocket.send_json(msg)
                        except Exception as send_err:
                            logger.warning(f"Worker {worker_id} - Failed to send websocket update (likely client disconnected): {send_err}")
                
                # 1. Update status: researching
                await safe_send({
                    "type": "status_update",
                    "claim_id": claim_id,
                    "claim_text": claim_text,
                    "status": "researching"
                })
                
                # ponytail: sequential to avoid deadlock — llm_semaphore capacity is 1
                logger.info(f"Worker {worker_id} - Running sequential research for claim: '{claim_text}'")
                angles = ["general_news", "official_data", "fact_check_sites"]
                drafts = {}
                for angle in angles:
                    try:
                        drafts[angle] = await run_research(claim_text, angle)
                    except Exception as res_err:
                        logger.error(f"Worker {worker_id} - Agent '{angle}' failed with exception: {res_err}")
                        drafts[angle] = ResearchDraft(
                            stance="missing_evidence",
                            confidence=0.0,
                            evidence_summary=f"Research agent error: {res_err}",
                            sources=[]
                        )

                # Check if all three research agents failed to compile evidence
                all_failed = all(d.stance == "missing_evidence" for d in drafts.values())
                
                if all_failed:
                    logger.warning(f"Worker {worker_id} - All research agents failed to compile evidence. Short-circuiting to 'unverifiable'.")
                    verdict_result = JudgeVerdict(
                        verdict="unverifiable",
                        explanation="Unverifiable: All research agents failed to retrieve relevant evidence from web searches. Please verify your connection or try again later.",
                        sources=[]
                    )
                else:
                    # 3. Update status: debating
                    await safe_send({
                        "type": "status_update",
                        "claim_id": claim_id,
                        "claim_text": claim_text,
                        "status": "debating"
                    })
                    
                    # 4. Debate Round
                    logger.info(f"Worker {worker_id} - Running debate round for claim: '{claim_text}'")
                    revised_drafts = await run_debate_round(claim_text, drafts)
                    
                    # 5. Judge Verdict
                    logger.info(f"Worker {worker_id} - Synthesizing final verdict for claim: '{claim_text}'")
                    verdict_result = await run_judge(claim_text, revised_drafts)
                
                # Convert sources to dictionaries for serialization
                sources_dict = [s.model_dump() for s in verdict_result.sources]
                
                # 6. Store in Database Cache (always cache even if client is currently disconnected)
                logger.info(f"Worker {worker_id} - Storing final verdict in database cache.")
                await cache.store_verdict(
                    claim_text=claim_text,
                    embedding=embedding,
                    verdict=verdict_result.verdict,
                    explanation=verdict_result.explanation,
                    sources=sources_dict
                )
                
                # 7. Update status: done (send final verdict update)
                await safe_send({
                    "type": "verdict_update",
                    "claim_id": claim_id,
                    "claim_text": claim_text,
                    "verdict": verdict_result.verdict,
                    "explanation": verdict_result.explanation,
                    "sources": sources_dict,
                    "cached": False
                })
                
            except Exception as pipeline_err:
                logger.error(f"Worker {worker_id} - Critical error in claim pipeline execution: {pipeline_err}")
                # Fallback to unverifiable if total failure
                await safe_send({
                    "type": "verdict_update",
                    "claim_id": claim_id,
                    "claim_text": claim_text,
                    "verdict": "unverifiable",
                    "explanation": f"Pipeline encountered a critical error: {pipeline_err}",
                    "sources": [],
                    "cached": False
                })
            finally:
                # Mark queue task as done
                pipeline_queue.task_done()
                logger.info(f"Worker {worker_id} - Finished processing claim: '{claim_text}'")

    except asyncio.CancelledError:
        logger.info(f"Worker {worker_id} cancelled.")
    except Exception as e:
        logger.error(f"Worker {worker_id} encountered exception: {e}")

def start_workers():
    """
    Spawns 2 concurrent queue worker tasks.
    """
    global worker_tasks
    if not worker_tasks:
        logger.info("Starting pipeline queue workers...")
        worker_tasks = [asyncio.create_task(worker_loop(i)) for i in range(config.NUM_PIPELINE_WORKERS)]

async def stop_workers():
    """
    Cancels and cleans up all queue worker tasks.
    """
    global worker_tasks
    if worker_tasks:
        logger.info("Stopping pipeline queue workers...")
        for task in worker_tasks:
            task.cancel()
        await asyncio.gather(*worker_tasks, return_exceptions=True)
        worker_tasks = []
        logger.info("Pipeline queue workers stopped.")
