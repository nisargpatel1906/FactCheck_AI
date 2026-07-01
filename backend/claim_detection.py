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
            "WHAT TO EXTRACT:\n"
            "- Objective factual statements with specific, verifiable details (e.g. 'India's GDP growth was 7.2% in 2024').\n"
            "- Statistical claims, numerical figures, dates, rankings, and comparative assertions.\n"
            "- Attributed quotes or actions by named public figures (e.g. 'The Finance Minister announced a new tax slab of 25%').\n"
            "- Historical events with specific claims about outcomes, dates, or participants.\n\n"
            "WHAT TO REJECT (return empty list if only these are present):\n"
            "- Subjective opinions, predictions, speculation, rhetorical questions, sarcasm, jokes.\n"
            "- Vague statements without checkable specifics (e.g. 'things are getting worse').\n"
            "- Self-referential claims about the speaker's own feelings, intentions, or plans.\n"
            "- Promotional slogans, hypothetical scenarios, and campaign promises about the future.\n\n"
            "FORMULATION RULES:\n"
            "1. Each claim MUST be a standalone, self-contained sentence. Resolve all pronouns (he, she, they, this, it) to the "
            "specific named entity from context. A reader with zero context must understand the claim.\n"
            "2. Preserve numerical precision exactly as stated — do not round, convert, or paraphrase numbers, percentages, dates, or currency amounts.\n"
            "3. If the transcript implies a specific country or region (from names, locations, institutions, or topics), "
            "embed that geographical context explicitly (e.g. 'The Prime Minister of India' not 'The Prime Minister').\n"
            "4. Preserve temporal context — include time references mentioned by the speaker (e.g. 'last year', 'in 2023', 'this quarter'). "
            "If the speaker says 'last year' and the current context year is known, retain the relative phrasing.\n"
            "5. Do NOT over-fragment. If a sentence contains multiple related facts forming a single logical narrative, "
            "extract it as ONE comprehensive claim. Only split when two genuinely independent facts happen to share a sentence.\n"
            "6. Do NOT duplicate — if the same fact is restated or paraphrased within the transcript window, extract it only once in its most complete form.\n"
            "7. When multiple speakers are present (e.g. a debate), attribute the claim to the speaker if identifiable from context "
            "(e.g. 'Candidate A claimed that unemployment fell to 3.5%').\n"
            "8. Maximum 5 claims per transcript window. Prioritize the most specific, most verifiable claims if more are present."
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
