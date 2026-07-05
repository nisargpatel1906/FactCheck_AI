import logging
import asyncio
from dataclasses import dataclass
import httpx
from duckduckgo_search import DDGS
from openai import AsyncOpenAI
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.openai import OpenAIProvider
import config
import api_keys
from schemas import ResearchDraft, Source

logger = logging.getLogger("backend.research_agent")


@dataclass
class AgentDeps:
    instructions: str


# ── Web search (Tavily with rotation → DuckDuckGo fallback) ──────────────────

async def search_web(query: str) -> str:
    """
    Searches Tavily (rotating through all TAVILY keys on failure),
    then falls back to DuckDuckGo if all Tavily keys are exhausted.
    """
    if api_keys.tavily_keys:
        for _ in range(len(api_keys.tavily_keys)):
            try:
                logger.info(f"Searching Tavily (key #{api_keys.tavily_keys.active_index}): '{query}'")
                async with httpx.AsyncClient() as client:
                    response = await client.post(
                        "https://api.tavily.com/search",
                        json={
                            "api_key": api_keys.tavily_keys.current,
                            "query": query,
                            "max_results": 3,
                            "search_depth": "basic",
                        },
                        timeout=8.0,
                    )
                if response.status_code == 200:
                    results = response.json().get("results", [])
                    return "\n".join(
                        f"Title: {r.get('title')}\nURL: {r.get('url')}\nContent: {r.get('content')}\n"
                        for r in results
                    )
                logger.error(
                    f"Tavily error {response.status_code} "
                    f"(key #{api_keys.tavily_keys.active_index}): {response.text[:200]}"
                )
            except Exception as e:
                logger.error(
                    f"Tavily exception (key #{api_keys.tavily_keys.active_index}): {e}"
                )

            if not api_keys.tavily_keys.rotate():
                logger.warning("All Tavily keys exhausted — falling back to DuckDuckGo.")
                break

    # DuckDuckGo fallback
    try:
        logger.info(f"Searching DuckDuckGo: '{query}'")
        def _ddg_sync():
            try:
                with DDGS(timeout=10) as ddgs:
                    return list(ddgs.text(query, max_results=3))
            except TypeError:
                with DDGS() as ddgs:
                    return list(ddgs.text(query, max_results=3))

        results = await asyncio.wait_for(asyncio.to_thread(_ddg_sync), timeout=12.0)
        return "\n".join(
            f"Title: {r.get('title')}\nURL: {r.get('href')}\nContent: {r.get('body')}\n"
            for r in results
        )
    except asyncio.TimeoutError:
        logger.error("DuckDuckGo search timed out after 12 seconds.")
        return "Search timed out."
    except Exception as e:
        logger.error(f"DuckDuckGo search failed: {e}")
        return "No search results found."


# ── Agent factory ─────────────────────────────────────────────────────────────

_SYSTEM_PROMPT = (
    "You are a specialized fact-checking research agent. Your job is to investigate a factual claim by "
    "searching the web for relevant evidence, evaluating source quality, and producing a structured research draft.\n\n"
    "INVESTIGATION PROCESS:\n"
    "1. Read the claim carefully. Identify the core assertion, any named entities, dates, numbers, and geographical context.\n"
    "2. Construct 2-3 targeted search queries. Include the specific entity names, dates, and keywords from the claim. "
    "Try at least one query that searches for counter-evidence or alternative perspectives.\n"
    "3. Evaluate each search result critically. Distinguish between primary sources (official data, court records, "
    "government reports) and secondary sources (news articles, opinion pieces, social media).\n\n"
    "SOURCE QUALITY HIERARCHY (most to least authoritative):\n"
    "- Official government data, statistical agencies, court records, parliamentary transcripts\n"
    "- Wire services and major international news agencies (Reuters, AP, AFP)\n"
    "- Established national newspapers of record\n"
    "- Dedicated fact-checking organizations (Snopes, PolitiFact, FactCheck.org, AltNews)\n"
    "- Regional news outlets and trade publications\n"
    "- Blogs, social media, and unverified sources (lowest weight — note unreliability if used)\n\n"
    "OUTPUT RULES:\n"
    "1. Choose a clear stance: 'supported', 'contradicted', 'mixed', or 'missing_evidence'.\n"
    "2. Confidence score (0.0-1.0) must reflect evidence quality:\n"
    "   - 0.9-1.0: Multiple authoritative primary sources agree.\n"
    "   - 0.7-0.89: Strong secondary sources agree, or one primary source confirms.\n"
    "   - 0.5-0.69: Mixed or conflicting evidence, or only secondary sources.\n"
    "   - Below 0.5: Weak, indirect, or insufficient evidence.\n"
    "3. Evidence summary: bullet points with specific facts, quotes, and data points. Cite which source each fact came from.\n"
    "4. Sources list: include title, URL, and domain for every source actually retrieved from your search. "
    "NEVER fabricate or guess URLs — only include URLs that appeared in your search results.\n"
    "5. If no relevant results are found after multiple searches, set stance to 'missing_evidence' with confidence below 0.3. "
    "Do not speculate.\n"
    "6. When investigating claims from regional contexts (e.g., India, Brazil), prioritize local-language and "
    "region-specific sources, official government data from that country, and regional fact-checkers."
)


def _make_research_agent(api_key: str) -> Agent | None:
    """Build a fresh research agent using the given NVIDIA API key."""
    if not api_key:
        return None
    try:
        client = AsyncOpenAI(base_url=config.NVIDIA_BASE_URL, api_key=api_key, timeout=20.0)
        provider = OpenAIProvider(openai_client=client)
        model = OpenAIModel(config.MODEL_RESEARCH, provider=provider)
        agent = Agent(
            model,
            retries=3,
            deps_type=AgentDeps,
            result_type=ResearchDraft,
            system_prompt=_SYSTEM_PROMPT,
        )

        @agent.tool
        async def search_web_tool(ctx: RunContext[AgentDeps], query: str) -> str:
            """Search the web for up-to-date news, reports, or fact checks matching the query."""
            return await search_web(query)

        @agent.system_prompt
        def add_runtime_instructions(ctx: RunContext[AgentDeps]) -> str:
            return ctx.deps.instructions

        return agent
    except Exception as e:
        logger.error(f"Failed to build research agent: {e}")
        return None


# Module-level agent — rebuilt on NVIDIA key rotation
research_agent = _make_research_agent(api_keys.nvidia_keys.current)


# ── Public API ────────────────────────────────────────────────────────────────

async def run_research(claim_text: str, angle: str) -> ResearchDraft:
    """
    Runs a web research agent for the given angle.
    Rotates through NVIDIA_API_KEY_1 … NVIDIA_API_KEY_8 on any API failure.
    Angles: 'general_news' | 'official_data' | 'fact_check_sites'
    """
    global research_agent

    _EMPTY = ResearchDraft(
        stance="missing_evidence", confidence=0.0,
        evidence_summary="Research agent failed on all API keys.", sources=[]
    )

    if not api_keys.nvidia_keys:
        logger.error("No NVIDIA API keys configured.")
        return _EMPTY

    if angle == "general_news":
        instr = (
            "You are the General News Agent. Focus your research on reputable mainstream journalism and wire services "
            "(Reuters, AP, AFP, BBC, Al Jazeera, major national papers). Your goal is to determine whether this claim "
            "is widely reported, what the journalistic consensus is, and whether any major outlet has reported contrary information.\n"
            "Search strategy: use the claim's key phrases as search terms. Try a second search adding 'fact check' or 'debunked' "
            "to find any existing journalistic scrutiny. Note the publication dates of your sources — recent coverage is more relevant."
        )
    elif angle == "official_data":
        instr = (
            "You are the Official Data Agent. Focus exclusively on primary authoritative sources: government statistical agencies "
            "(BLS, Census Bureau, RBI, MOSPI, Eurostat), official .gov/.org sites, parliamentary records, court filings, "
            "peer-reviewed academic papers, and institutional reports (WHO, IMF, World Bank).\n"
            "Your goal is to find the actual underlying data behind the claim — raw numbers, official statistics, or legal records "
            "that either confirm or contradict the specific figures, dates, or events asserted.\n"
            "Search strategy: include the name of the relevant institution or database in your search query. "
            "If the claim cites a specific number, search for the official source of that number."
        )
    elif angle == "fact_check_sites":
        instr = (
            "You are the Fact-Check Agent. Focus exclusively on dedicated fact-checking publications: Snopes, PolitiFact, "
            "FactCheck.org, Reuters Fact Check, AFP Fact Check, Full Fact, AltNews, Boom Live, The Quint Fact Check.\n"
            "Your goal is to determine whether this exact claim (or a substantially similar version) has already been "
            "investigated by professional fact-checkers, and what verdict they reached.\n"
            "Search strategy: search for the claim's core assertion combined with 'fact check' or the name of a specific "
            "fact-checking organization. If no existing fact-check is found, explicitly state that in your evidence summary "
            "and set stance to 'missing_evidence'."
        )
    else:
        instr = "Research the claim thoroughly using the web search tool."

    deps = AgentDeps(instructions=instr)
    logger.info(f"Running research agent ({angle}) for: '{claim_text}'")

    for _ in range(len(api_keys.nvidia_keys)):
        agent = research_agent
        if agent is None:
            logger.error("Research agent could not be initialized.")
            return _EMPTY
        try:
            async with config.llm_semaphore:
                result = await agent.run(claim_text, deps=deps)
            return result.output
        except Exception as e:
            logger.error(
                f"Research agent ({angle}) failed "
                f"(key #{api_keys.nvidia_keys.active_index}): {e}"
            )

        if not api_keys.nvidia_keys.rotate():
            break
        research_agent = _make_research_agent(api_keys.nvidia_keys.current)

    logger.error(f"Research agent ({angle}) failed on all NVIDIA API keys.")
    return _EMPTY
