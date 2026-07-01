import logging
import asyncio
from dataclasses import dataclass
import httpx
from duckduckgo_search import DDGS
from openai import AsyncOpenAI
from pydantic_ai import Agent, RunContext
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai import OpenAIProvider
import config
from schemas import ResearchDraft, Source

logger = logging.getLogger("backend.research_agent")

@dataclass
class AgentDeps:
    instructions: str

# 1. Set up search tool helper
async def search_web(query: str) -> str:
    """
    Asynchronously queries Tavily API if active, or falls back to DuckDuckGo search.
    """
    if config.TAVILY_API_KEY:
        try:
            logger.info(f"Searching Tavily for: '{query}'")
            async with httpx.AsyncClient() as client:
                response = await client.post(
                    "https://api.tavily.com/search",
                    json={
                        "api_key": config.TAVILY_API_KEY,
                        "query": query,
                        "max_results": 3,
                        "search_depth": "basic"
                    },
                    timeout=8.0
                )
            if response.status_code == 200:
                results = response.json().get("results", [])
                formatted = []
                for r in results:
                    formatted.append(f"Title: {r.get('title')}\nURL: {r.get('url')}\nContent: {r.get('content')}\n")
                return "\n".join(formatted)
        except Exception as e:
            logger.error(f"Tavily search failed: {e}. Falling back to DuckDuckGo.")

    # Fallback to DuckDuckGo Search
    try:
        logger.info(f"Searching DuckDuckGo for: '{query}'")
        def ddg_sync():
            try:
                with DDGS(timeout=10) as ddgs:
                    return list(ddgs.text(query, max_results=3))
            except TypeError:
                with DDGS() as ddgs:
                    return list(ddgs.text(query, max_results=3))
        results = await asyncio.wait_for(asyncio.to_thread(ddg_sync), timeout=12.0)
        formatted = []
        for r in results:
            formatted.append(f"Title: {r.get('title')}\nURL: {r.get('href')}\nContent: {r.get('body')}\n")
        return "\n".join(formatted)
    except asyncio.TimeoutError:
        logger.error(f"DuckDuckGo search timed out after 12 seconds.")
        return "Search timed out."
    except Exception as e:
        logger.error(f"DuckDuckGo search failed: {e}")
        return "No search results found."

# 2. Set up Pydantic AI agent
try:
    openai_client = AsyncOpenAI(
        base_url=config.NVIDIA_BASE_URL,
        api_key=config.NVIDIA_API_KEY,
        timeout=20.0
    )
    provider = OpenAIProvider(openai_client=openai_client)
    model = OpenAIChatModel(config.MODEL_RESEARCH, provider=provider)

    research_agent = Agent(
        model,
        retries=3,
        deps_type=AgentDeps,
        output_type=ResearchDraft,
        system_prompt=(
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
    )

    @research_agent.tool
    async def search_web_tool(ctx: RunContext[AgentDeps], query: str) -> str:
        """
        Search the web for up-to-date news, reports, tables, or fact checks matching the query.
        Use this tool to find evidence related to the claim.
        """
        return await search_web(query)

    @research_agent.system_prompt
    def add_runtime_instructions(ctx: RunContext[AgentDeps]) -> str:
        return ctx.deps.instructions

except Exception as e:
    logger.error(f"Failed to initialize research agent: {e}")
    research_agent = None

async def run_research(claim_text: str, angle: str) -> ResearchDraft:
    """
    Executes a web research agent with customized guidelines based on the research angle.
    Angles: 'general_news', 'official_data', 'fact_check_sites'
    """
    if not research_agent:
        logger.error("Research agent not initialized. Returning empty draft.")
        return ResearchDraft(stance="missing_evidence", confidence=0.0, evidence_summary="Agent uninitialized.", sources=[])

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

    logger.info(f"Running research agent ({angle}) for claim: '{claim_text}'")
    deps = AgentDeps(instructions=instr)
    
    try:
        async with config.llm_semaphore:
            result = await research_agent.run(claim_text, deps=deps)
        return result.output
    except Exception as e:
        logger.error(f"Research agent ({angle}) execution failed: {e}")
        return ResearchDraft(
            stance="missing_evidence",
            confidence=0.0,
            evidence_summary=f"Research agent failed: {e}",
            sources=[]
        )
