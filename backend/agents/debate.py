import logging
import asyncio
import config
import api_keys
from schemas import ResearchDraft
import agents.research_agent as research_agent_mod

logger = logging.getLogger("backend.debate")

async def run_debate_for_agent(
    claim_text: str,
    angle: str,
    self_draft: ResearchDraft,
    other_drafts: list[tuple[str, ResearchDraft]]
) -> ResearchDraft:
    """
    Runs a single agent's debate revision round.
    Rotates NVIDIA keys on failure, same as run_research().
    """
    other_drafts_text = "".join(
        f"[{other_angle.replace('_', ' ').title()} Agent]\n"
        f"- Stance: {draft.stance}\n"
        f"- Confidence: {draft.confidence}\n"
        f"- Evidence:\n{draft.evidence_summary}\n"
        f"- Sources: {', '.join(s.url for s in draft.sources)}\n\n"
        for other_angle, draft in other_drafts
    )

    user_prompt = (
        f"You previously investigated the claim: '{claim_text}' "
        f"and generated this draft stance: '{self_draft.stance}' with confidence {self_draft.confidence}.\n\n"
        f"Here are the drafts compiled by your peer research agents who looked at different angles:\n"
        f"{other_drafts_text}"
        f"Please analyze their compiled evidence and stances. Review if their facts contradict or support your stance, "
        f"and output your final revised research draft. You may change your stance or adjust your confidence based on their evidence."
    )

    instr = (
        f"You are participating in a collaborative debate round as the {angle.replace('_', ' ').title()} Agent. "
        "You have already completed your initial research. Now review your peer agents' findings and revise your draft.\n\n"
        "DEBATE REVISION PROCESS:\n"
        "1. COMPARE: For each peer draft, check whether their evidence supports, contradicts, or is independent of your own findings.\n"
        "2. IDENTIFY CONFLICTS: If another agent found evidence that directly contradicts yours, evaluate which source is more "
        "authoritative (official data > wire services > news articles > blogs). Adjust your stance accordingly.\n"
        "3. ABSORB: If a peer found strong supporting evidence you missed, incorporate it into your evidence summary and "
        "increase your confidence. Credit the source.\n"
        "4. REVISE HONESTLY: If the combined evidence changes your assessment, update your stance and confidence. "
        "It is better to change your mind based on evidence than to defend an incorrect position.\n"
        "5. FINAL OUTPUT: Produce a revised ResearchDraft with your updated stance, adjusted confidence, enriched evidence summary, "
        "and a consolidated sources list that includes any newly adopted sources from peers.\n\n"
        "IMPORTANT: Do NOT simply average stances or split the difference. Weigh evidence quality. "
        "If one agent has a .gov source confirming a number and another has a blog post denying it, the .gov source wins."
    )

    deps = research_agent_mod.AgentDeps(instructions=instr)

    for _ in range(len(api_keys.nvidia_keys)):
        # Always read the module-level variable — it gets rebuilt after rotation
        agent = research_agent_mod.research_agent
        if agent is None:
            return self_draft
        try:
            async with config.llm_semaphore:
                result = await agent.run(user_prompt, deps=deps)
            logger.info(
                f"Debate round complete for '{angle}'. "
                f"Stance: '{self_draft.stance}' -> '{result.output.stance}'"
            )
            return result.output
        except Exception as e:
            logger.error(
                f"Agent '{angle}' debate round failed "
                f"(key #{api_keys.nvidia_keys.active_index}): {e}"
            )

        if not api_keys.nvidia_keys.rotate():
            break
        research_agent_mod.research_agent = research_agent_mod._make_research_agent(
            api_keys.nvidia_keys.current
        )

    logger.error(f"Debate round for '{angle}' failed on all NVIDIA API keys.")
    return self_draft

async def run_debate_round(claim_text: str, drafts: dict[str, ResearchDraft]) -> dict[str, ResearchDraft]:
    """
    Executes the debate round for all three agents in parallel.
    Each agent is shown the drafts of the other two agents.
    """
    logger.info(f"Starting collaborative debate round for claim: '{claim_text}'")
    
    # ponytail: sequential to avoid deadlock — llm_semaphore capacity is 1
    angles = list(drafts.keys())
    revised_drafts = {}

    for angle in angles:
        self_draft = drafts[angle]
        other_drafts = [(other, drafts[other]) for other in angles if other != angle]
        revised_drafts[angle] = await run_debate_for_agent(claim_text, angle, self_draft, other_drafts)

    return revised_drafts
