from pydantic import BaseModel, Field

class Source(BaseModel):
    title: str = Field(description="Title of the source website or article.")
    url: str = Field(description="Direct URL of the source page.")
    domain: str = Field(description="Domain name of the source (e.g., bls.gov, reuters.com).")

class ResearchDraft(BaseModel):
    stance: str = Field(
        description="The research agent's stance on the claim. Must be exactly one of: 'supported', 'contradicted', 'mixed', or 'missing_evidence'."
    )
    confidence: float = Field(
        description="The confidence score of the stance, from 0.0 (completely unsure) to 1.0 (fully certain)."
    )
    evidence_summary: str = Field(
        description="A bulleted summary of key facts, arguments, and data points compiled from search results."
    )
    sources: list[Source] = Field(
        default_factory=list,
        description="A list of direct search sources used to compile this draft."
    )

class JudgeVerdict(BaseModel):
    verdict: str = Field(
        description="The final verdict synthesized from all agent inputs. Must be exactly one of: 'supported', 'contradicted', 'mixed', 'unverifiable'."
    )
    explanation: str = Field(
        description="A clear, objective explanation summarizing the verdict and detailing why it was chosen based on the compiled evidence."
    )
    sources: list[Source] = Field(
        default_factory=list,
        description="A consolidated list of the most authoritative sources supporting the verdict."
    )
