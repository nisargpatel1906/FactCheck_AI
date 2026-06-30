import logging
from pydantic import BaseModel, Field
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
import config

logger = logging.getLogger("backend.claim_detection")

# Structured output format for claim extraction
class DetectedClaims(BaseModel):
    claims: list[str] = Field(
        default_factory=list,
        description="A list of standalone, objective, checkable factual claims extracted from the transcript chunk."
    )

# Initialize OpenAI-compatible client for NVIDIA NIM API
try:
    openai_client = AsyncOpenAI(
        base_url=config.NVIDIA_BASE_URL,
        api_key=config.NVIDIA_API_KEY
    )
    provider = OpenAIProvider(openai_client=openai_client)
    model = OpenAIChatModel(config.MODEL_CLAIM_DETECTION, provider=provider)
    
    # Initialize Pydantic AI Agent
    claim_agent = Agent(
        model,
        output_type=DetectedClaims,
        retries=2,
        system_prompt=(
            "You are an expert AI assistant specializing in analyzing transcripts of live audio or video streams "
            "and extracting checkable factual claims. A checkable claim is an assertion about a real-world entity, "
            "event, statistic, or historical fact that can be verified as true or false using evidence, search engines, "
            "or official databases.\n\n"
            "Guidelines:\n"
            "1. Extract ONLY objective factual statements (e.g. 'Inflation has risen by 10% this year').\n"
            "2. DO NOT extract subjective opinions, predictions, personal preferences, questions, jokes, or conversational filler.\n"
            "3. Formulate each claim so that it stands alone as a complete sentence with full context (resolving pronouns like 'he', 'they', or 'this' to their corresponding entities if clear from the context).\n"
            "4. If no checkable factual claims are present in the text, return an empty list."
        )
    )
except Exception as e:
    logger.error(f"Failed to initialize claim detection agent: {e}")
    claim_agent = None

async def detect_claims(text: str) -> list[str]:
    """
    Analyzes a block of transcript text and returns a list of detected factual claims.
    Uses a single structured model call to Nemotron Nano to ensure rate limit efficiency.
    """
    if not text.strip():
        return []
        
    if not config.NVIDIA_API_KEY:
        logger.error("NVIDIA_API_KEY is not set. Skipping claim detection.")
        return []

    if claim_agent is None:
        logger.error("Claim detection agent is not initialized.")
        return []

    try:
        logger.info(f"Running claim detection on transcript window ({len(text)} chars)...")
        async with config.llm_semaphore:
            response = await claim_agent.run(text)
        detected = response.output.claims
        logger.info(f"Claim detection model returned {len(detected)} claims.")
        return [c.strip() for c in detected if c.strip()]
    except Exception as e:
        logger.error(f"Error during claim detection call: {e}")
        return []
