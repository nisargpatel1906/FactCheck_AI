import os
from pathlib import Path
from dotenv import load_dotenv

# Load env variables from backend/.env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# API Keys
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")

# Base Endpoints
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")

# NVIDIA NIM Models — verify current IDs at build.nvidia.com before first use
# PRD section 12.2: Nano for claim detection, Super for research, Ultra for judge
MODEL_CLAIM_DETECTION = os.getenv("MODEL_CLAIM_DETECTION", "meta/llama-3.1-8b-instruct")
MODEL_RESEARCH = os.getenv("MODEL_RESEARCH", "meta/llama-3.1-8b-instruct")
MODEL_JUDGE = os.getenv("MODEL_JUDGE", "meta/llama-3.1-8b-instruct")
MODEL_EMBEDDING = os.getenv("MODEL_EMBEDDING", "nvidia/nv-embedqa-e5-v5")
MODEL_STT = os.getenv("MODEL_STT", "openai/whisper-large-v3")

# Cache & Storage
# If DATABASE_URL is set, PostgreSQL is used. Otherwise falls back to local SQLite.
DATABASE_URL = os.getenv("DATABASE_URL", "")
DATABASE_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "factcheck.db"))
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.85"))

# Pipeline settings
CLAIM_DETECTION_WINDOW_SECONDS = int(os.getenv("CLAIM_DETECTION_WINDOW_SECONDS", "20"))
NUM_PIPELINE_WORKERS = int(os.getenv("NUM_PIPELINE_WORKERS", "2"))

import asyncio
# ponytail: Semaphore(1) serializes all LLM calls — intentional for NVIDIA NIM free-tier rate limits.
# Upgrade path: increase capacity or use per-model semaphores when rate limits allow.
llm_semaphore = asyncio.Semaphore(1)
