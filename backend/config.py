import os
from pathlib import Path
from dotenv import load_dotenv

# Load env variables from backend/.env
BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# API Keys
NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")

# Base Endpoints
NVIDIA_BASE_URL = os.getenv("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")

# NVIDIA NIM Models — verify current IDs at build.nvidia.com before first use
# PRD section 12.2: Nano for claim detection, Super for research, Ultra for judge
MODEL_CLAIM_DETECTION = os.getenv("MODEL_CLAIM_DETECTION", "nvidia/llama-3.1-nemotron-nano-8b-v1")
MODEL_RESEARCH = os.getenv("MODEL_RESEARCH", "nvidia/llama-3.1-nemotron-super-49b-v1")
MODEL_JUDGE = os.getenv("MODEL_JUDGE", "nvidia/llama-3.1-nemotron-ultra-253b-v1")
MODEL_EMBEDDING = os.getenv("MODEL_EMBEDDING", "nvidia/nv-embedqa-e5-v5")
MODEL_STT = os.getenv("MODEL_STT", "nvidia/parakeet-ctc-1.1b-asr")

# Cache & Storage
DATABASE_PATH = os.getenv("DATABASE_PATH", str(BASE_DIR / "factcheck.db"))
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.85"))

# Pipeline settings
CLAIM_DETECTION_WINDOW_SECONDS = int(os.getenv("CLAIM_DETECTION_WINDOW_SECONDS", "20"))
NUM_PIPELINE_WORKERS = int(os.getenv("NUM_PIPELINE_WORKERS", "2"))
