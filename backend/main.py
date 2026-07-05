import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import stt
import claim_detection
import cache
from agents.research_agent import run_research
from agents.debate import run_debate_for_agent
from agents.judge import run_judge
from schemas import (
    STTRequest, STTResponse,
    DetectClaimsRequest, DetectClaimsResponse,
    ResearchRequest, ResearchDraft,
    DebateRequest, JudgeRequest, JudgeVerdict,
    CacheLookupRequest, CacheLookupResponse,
    StoreVerdictRequest
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("backend")

app = FastAPI(title="FactCheck AI REST Backend")

# Allow CORS for Chrome Extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "FactCheck AI REST Backend is running"}

@app.post("/api/stt", response_model=STTResponse)
async def api_stt(req: STTRequest):
    """Decodes base64 audio and translates it to English text."""
    if not req.audio_base64:
        return STTResponse(text="")
    
    text = await stt.transcribe_audio(req.audio_base64)
    return STTResponse(text=text)

@app.post("/api/detect_claims", response_model=DetectClaimsResponse)
async def api_detect_claims(req: DetectClaimsRequest):
    """Extracts verifiable claims from a rolling transcript window."""
    if not req.transcript_window.strip():
        return DetectClaimsResponse(claims=[])
    
    claims = await claim_detection.detect_claims(req.transcript_window)
    return DetectClaimsResponse(claims=claims)

@app.post("/api/cache_lookup", response_model=CacheLookupResponse)
async def api_cache_lookup(req: CacheLookupRequest):
    """Checks the semantic cache for an already fact-checked claim."""
    embedding = await cache.get_embedding(req.claim_text)
    if not embedding:
        return CacheLookupResponse(cached=False)
    
    cached = await cache.search_cache_by_embedding(embedding)
    if cached:
        return CacheLookupResponse(
            cached=True,
            verdict=cached["verdict"],
            explanation=cached["explanation"],
            sources=cached["sources"]
        )
    return CacheLookupResponse(cached=False)

@app.post("/api/research", response_model=ResearchDraft)
async def api_research(req: ResearchRequest):
    """Runs a single research agent for a specific angle."""
    try:
        draft = await run_research(req.claim_text, req.angle)
        return draft
    except Exception as e:
        logger.error(f"Research error for angle {req.angle}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/debate", response_model=ResearchDraft)
async def api_debate(req: DebateRequest):
    """Runs the debate revision round for a single agent."""
    other_drafts_list = list(req.other_drafts.items())
    try:
        revised = await run_debate_for_agent(
            claim_text=req.claim_text,
            angle=req.angle,
            self_draft=req.self_draft,
            other_drafts=other_drafts_list
        )
        return revised
    except Exception as e:
        logger.error(f"Debate error for angle {req.angle}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/judge", response_model=JudgeVerdict)
async def api_judge(req: JudgeRequest):
    """Synthesizes final verdict from the revised drafts."""
    try:
        verdict = await run_judge(req.claim_text, req.revised_drafts)
        return verdict
    except Exception as e:
        logger.error(f"Judge error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/cache")
async def api_store_cache(req: StoreVerdictRequest):
    """Stores a finalized verdict in the semantic cache."""
    embedding = await cache.get_embedding(req.claim_text)
    sources_dict = [s.model_dump() for s in req.verdict_data.sources]
    
    await cache.store_verdict(
        claim_text=req.claim_text,
        embedding=embedding,
        verdict=req.verdict_data.verdict,
        explanation=req.verdict_data.explanation,
        sources=sources_dict
    )
    return {"status": "ok"}
