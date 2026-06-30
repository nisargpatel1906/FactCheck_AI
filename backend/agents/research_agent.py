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
            with DDGS() as ddgs:
                # Limit results to keep context concise
                return list(ddgs.text(query, max_results=3))
        results = await asyncio.to_thread(ddg_sync)
        formatted = []
        for r in results:
            formatted.append(f"Title: {r.get('title')}\nURL: {r.get('href')}\nContent: {r.get('body')}\n")
        return "\n".join(formatted)
    except Exception as e:
        logger.error(f"DuckDuckGo search failed: {e}")
        return "No search results found."

# 2. Set up Pydantic AI agent
try:
    openai_client = AsyncOpenAI(
        base_url=config.NVIDIA_BASE_URL,
        api_key=config.NVIDIA_API_KEY
    )
    provider = OpenAIProvider(openai_client=openai_client)
    model = OpenAIChatModel(config.MODEL_RESEARCH, provider=provider)

    research_agent = Agent(
        model,
        retries=3,
        deps_type=AgentDeps,
        output_type=ResearchDraft,
        system_prompt=(
            "You are a specialized fact-checking research agent. Your job is to analyze the user's factual claim, "
            "search the web to find relevant evidence (quotes, dates, statistics, official reports), "
            "and produce a structured research draft.\n\n"
            "Guidelines:\n"
            "1. Choose a clear stance (supported, contradicted, mixed, or missing_evidence).\n"
            "2. Provide a confidence score between 0.0 and 1.0.\n"
            "3. Summarize your evidence in bullet points.\n"
            "4. Compile a list of direct search sources (including title, url, domain).\n"
            "5. Rely only on verified information retrieved from the search tool. Do not hallucinate URLs."
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
            "Focus your research on reputable general news publications, official announcements, and journalism outlets (e.g., Reuters, AP, BBC, etc.). "
            "Investigate if this claim is widely reported and what the consensus is."
        )
    elif angle == "official_data":
        instr = (
            "Focus your research on primary official statistical agencies (e.g., Bureau of Labor Statistics, Census Bureau, EPA), government sites (.gov, .org), "
            "or peer-reviewed academic papers. Prioritize concrete numbers, statistical tables, and raw database facts."
        )
    elif angle == "fact_check_sites":
        instr = (
            "Focus your research on major dedicated fact-checking publications (e.g., Snopes, PolitiFact, FactCheck.org, Reuters Fact Check). "
            "Verify if this claim has already been investigated and what verdict those sites issued."
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
