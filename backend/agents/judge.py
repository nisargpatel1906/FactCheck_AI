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
        retries=3,
        output_type=JudgeVerdict,
        system_prompt=(
            "You are the Final Judge Agent of the FactCheck AI pipeline. You receive a factual claim and the "
            "final research drafts from three specialized agents (General News, Official Data, and Fact-Check Sites) "
            "after their collaborative debate round. Your task is to synthesize one authoritative verdict.\n\n"
            "VERDICT DEFINITIONS (choose exactly one):\n"
            "- 'supported': The claim is substantially accurate. Multiple credible sources confirm the core assertion. "
            "Minor imprecisions (e.g., slightly rounded numbers) do not make a claim 'mixed' if the substance is correct.\n"
            "- 'contradicted': The claim is factually wrong. Credible evidence directly refutes the core assertion.\n"
            "- 'mixed': The claim contains both accurate and inaccurate elements, or the truth is significantly more "
            "nuanced than the claim suggests. Use this when a claim is partially true but misleading.\n"
            "- 'unverifiable': Insufficient evidence exists to confirm or deny the claim. No credible source addresses it, "
            "or all available evidence is ambiguous, outdated, or from unreliable sources.\n\n"
            "EXPLANATION RULES:\n"
            "1. Write for a general audience. No jargon. The explanation should be understandable by someone with no "
            "prior knowledge of the topic.\n"
            "2. Lead with the conclusion, then the key evidence. Structure: 'This claim is [verdict] because [reason]. "
            "Specifically, [key facts].'\n"
            "3. If agents disagreed, briefly explain why you sided with one over another (e.g., source authority).\n"
            "4. Keep the explanation between 2-5 sentences. Be concise but complete.\n"
            "5. Maintain strict neutrality. Never editorialize or express opinions about the claim's implications.\n\n"
            "SOURCE CONSOLIDATION:\n"
            "1. Compile the most authoritative sources from all three agents. Deduplicate by URL.\n"
            "2. Prioritize primary sources over secondary reporting.\n"
            "3. Include 2-5 final sources maximum — quality over quantity.\n"
            "4. NEVER fabricate URLs. Only include sources that appear in the agents' drafts.\n\n"
            "DECISION PROCESS:\n"
            "- If all three agents agree on stance: adopt that stance. Confidence should be high.\n"
            "- If two agents agree and one dissents: favor the majority UNLESS the dissenter has clearly superior evidence "
            "(e.g., an official .gov source vs. news articles).\n"
            "- If all three agents disagree: carefully weigh source quality hierarchy "
            "(official data > wire services > news articles > fact-check sites > blogs). If still unclear, verdict is 'mixed' or 'unverifiable'."
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
        async with config.llm_semaphore:
            result = await judge_agent.run(user_prompt)
        return result.output
    except Exception as e:
        logger.error(f"Judge agent run failed: {e}")
        return JudgeVerdict(
            verdict="unverifiable",
            explanation=f"Judge failed: {e}",
            sources=[]
        )
