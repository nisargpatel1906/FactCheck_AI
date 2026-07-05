from pydantic import BaseModel, Field
from typing import Literal

class Source(BaseModel):
    title: str = Field(description="Title of the source website or article.")
    url: str = Field(description="Direct URL of the source page.")
    domain: str = Field(description="Domain name of the source (e.g., bls.gov, reuters.com).")

class ResearchDraft(BaseModel):
    stance: Literal['supported', 'contradicted', 'mixed', 'missing_evidence'] = Field(
        description="The research agent's stance on the claim. Must be exactly one of the allowed values."
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
    verdict: Literal['supported', 'contradicted', 'mixed', 'unverifiable'] = Field(
        description="The final verdict synthesized from all agent inputs. Must be exactly one of the allowed values."
    )
    explanation: str = Field(
        description="A clear, objective explanation summarizing the verdict and detailing why it was chosen based on the compiled evidence."
    )
    sources: list[Source] = Field(
        default_factory=list,
        description="A consolidated list of the most authoritative sources supporting the verdict."
    )

# --- REST API Request & Response Models ---

class STTRequest(BaseModel):
    audio_base64: str

class STTResponse(BaseModel):
    text: str

class DetectClaimsRequest(BaseModel):
    transcript_window: str

class DetectClaimsResponse(BaseModel):
    claims: list[str]

class ResearchRequest(BaseModel):
    claim_text: str
    angle: Literal['general_news', 'official_data', 'fact_check_sites']

class DebateRequest(BaseModel):
    claim_text: str
    angle: Literal['general_news', 'official_data', 'fact_check_sites']
    self_draft: ResearchDraft
    other_drafts: dict[str, ResearchDraft] # mapping of angle -> draft

class JudgeRequest(BaseModel):
    claim_text: str
    revised_drafts: dict[str, ResearchDraft]

class CacheLookupRequest(BaseModel):
    claim_text: str
    device_id: str | None = None

class CacheLookupResponse(BaseModel):
    cached: bool
    verdict: str | None = None
    explanation: str | None = None
    sources: list[Source] | None = None

class StoreVerdictRequest(BaseModel):
    claim_text: str
    verdict_data: JudgeVerdict
