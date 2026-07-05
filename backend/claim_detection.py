import logging
from pydantic import BaseModel, Field
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
import config
import api_keys

logger = logging.getLogger("backend.claim_detection")


class DetectedClaims(BaseModel):
    claims: list[str] = Field(
        default_factory=list,
        description="A list of standalone, objective, checkable factual claims extracted from the transcript chunk."
    )

_SYSTEM_PROMPT = (
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
    "5. SYNTHESIZE AND CONSOLIDATE: Do NOT atomize the speaker's narrative into multiple minor claims. "
    "If the speaker is making a single broader argument containing several related facts (e.g., 'E15 fuel damages cars by clogging tanks, ruining injectors, and reducing efficiency to 9-10'), "
    "you MUST combine these related points into ONE comprehensive claim to fact-check the overall narrative.\n"
    "6. Do NOT duplicate — if the same fact is restated or paraphrased within the transcript window, extract it only once in its most complete form.\n"
    "7. When multiple speakers are present (e.g. a debate), attribute the claim to the speaker if identifiable from context.\n"
    "8. MAXIMUM EFFICIENCY: Return a maximum of 1 or 2 core claims per transcript window. Focus entirely on the central, most critical verifiable assertion being made."
)


def _make_claim_agent(api_key: str) -> Agent | None:
    """Build a fresh claim-detection agent using the given NVIDIA API key."""
    if not api_key:
        return None
    try:
        client = AsyncOpenAI(base_url=config.NVIDIA_BASE_URL, api_key=api_key, timeout=20.0)
        provider = OpenAIProvider(openai_client=client)
        model = OpenAIModel(config.MODEL_CLAIM_DETECTION, provider=provider)
        return Agent(model, result_type=DetectedClaims, retries=2, system_prompt=_SYSTEM_PROMPT)
    except Exception as e:
        logger.error(f"Failed to build claim detection agent: {e}")
        return None


# Module-level agent — rebuilt on key rotation
claim_agent = _make_claim_agent(api_keys.nvidia_keys.current)


async def detect_claims(text: str) -> list[str]:
    """
    Analyzes a transcript window and returns detected factual claims.
    Rotates through NVIDIA_API_KEY_1 … NVIDIA_API_KEY_8 on any API failure.
    """
    global claim_agent

    if not text.strip():
        return []
    if not api_keys.nvidia_keys:
        logger.error("No NVIDIA API keys configured. Skipping claim detection.")
        return []

    for _ in range(len(api_keys.nvidia_keys)):
        agent = claim_agent
        if agent is None:
            logger.error("Claim detection agent could not be initialized.")
            return []
        try:
            logger.info(f"Running claim detection ({len(text)} chars, key #{api_keys.nvidia_keys.active_index})...")
            async with config.llm_semaphore:
                response = await agent.run(text)
            detected = response.data.claims
            logger.info(f"Claim detection returned {len(detected)} claim(s).")
            return [c.strip() for c in detected if c.strip()]
        except Exception as e:
            logger.error(
                f"Claim detection failed (key #{api_keys.nvidia_keys.active_index}): {e}"
            )

        if not api_keys.nvidia_keys.rotate():
            break
        claim_agent = _make_claim_agent(api_keys.nvidia_keys.current)

    logger.error("Claim detection failed on all NVIDIA API keys.")
    return []
