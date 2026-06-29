import logging
from openai import AsyncOpenAI
from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
import config
from schemas import ResearchDraft, JudgeVerdict

logger = logging.getLogger("backend.judge")

try:
    openai_client = AsyncOpenAI(
        base_url=config.NVIDIA_BASE_URL,
        api_key=config.NVIDIA_API_KEY
    )
    provider = OpenAIProvider(openai_client=openai_client)
    model = OpenAIChatModel(config.MODEL_JUDGE, provider=provider)

    judge_agent = Agent(
        model,
        output_type=JudgeVerdict,
        system_prompt=(
            "You are the Final Judge Agent of the FactCheck AI pipeline. "
            "Your task is to analyze a user's factual claim and synthesize the final research drafts compiled "
            "by three specialized research agents after their collaborative debate.\n\n"
            "Guidelines:\n"
            "1. Output a final verdict category. This must be exactly one of: 'supported', 'contradicted', 'mixed', 'unverifiable'.\n"
            "2. Provide a clear, objective, and neutral explanation of the verdict, summarizing the key facts and resolving any discrepancies.\n"
            "3. Consolidate a list of the most relevant and authoritative source links compiled by the agents.\n"
            "4. Maintain strict objectivity and rely strictly on the evidence provided in the drafts. Do not hallucinate external facts or URLs."
        )
    )

except Exception as e:
    logger.error(f"Failed to initialize judge agent: {e}")
    judge_agent = None

async def run_judge(claim_text: str, revised_drafts: dict[str, ResearchDraft]) -> JudgeVerdict:
    """
    Synthesizes the final verdict based on the revised research drafts.
    """
    if not judge_agent:
        logger.error("Judge agent not initialized. Returning unverifiable verdict.")
        return JudgeVerdict(
            verdict="unverifiable",
            explanation="Judge agent uninitialized.",
            sources=[]
        )

    # Format drafts for the judge
    drafts_text = ""
    for angle, draft in revised_drafts.items():
        drafts_text += (
            f"=== {angle.replace('_', ' ').title()} Agent Findings ===\n"
            f"Stance: {draft.stance}\n"
            f"Confidence: {draft.confidence}\n"
            f"Evidence summary:\n{draft.evidence_summary}\n"
            f"Sources: {', '.join([f'{s.title} ({s.url})' for s in draft.sources])}\n\n"
        )

    user_prompt = (
        f"Claim to verify: '{claim_text}'\n\n"
        f"Here are the final research drafts from the agents after the debate round:\n\n"
        f"{drafts_text}"
        f"Please analyze the stances and compiled evidence to produce your final verdict."
    )

    logger.info(f"Running judge agent for claim: '{claim_text}'")
    try:
        result = await judge_agent.run(user_prompt)
        return result.data
    except Exception as e:
        logger.error(f"Judge agent run failed: {e}")
        return JudgeVerdict(
            verdict="unverifiable",
            explanation=f"Judge failed: {e}",
            sources=[]
        )
