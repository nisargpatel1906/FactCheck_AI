# Product Requirements Document — FactCheck AI

## 0. How to use this document

This file describes everything about the project: what it is, why it exists, and exactly how every piece of it should work, down to the actual message formats and pseudocode for the trickiest logic. It is written so an AI coding agent (or a human developer who has never seen this project before) can read it once and build the system without needing to guess anything.

Two other files sit next to this one and must always be read together with it:
- `BRAND_GUIDE.md` — exact colors, fonts, spacing, CSS variables, and component markup to use for anything visual.
- `PROMPT.md` — the actual instructions to give an AI coding agent, including build order and per-phase checklists.

**Rule for ambiguity:** if anything below is unclear, incomplete, or contradicts something else in this document, the correct behavior is to stop and ask a clarifying question. Never silently guess and never silently expand scope beyond what is written here.

---

## 1. One-line summary

FactCheck AI is a Chrome browser extension that listens to whatever video is playing on the current tab, automatically detects spoken political or factual claims, checks them against real web sources using a team of AI agents, and shows the verdict (Supported / Contradicted / Mixed / Unverifiable) in a small overlay panel on the page, in close to real time.

---

## 2. Why this exists (the problem)

People watch political speeches, debates, and news clips and have no easy way to know, in the moment, whether a specific spoken claim is true. Looking it up themselves means pausing, opening a new tab, searching, reading several articles, and coming back — friction most people never bother with. This tool removes that friction by doing the lookup automatically while the video plays.

---

## 3. Glossary (plain-word definitions of every term used in this document)

- **Browser extension**: a small program that runs inside Chrome and can see/modify the pages a user visits.
- **Manifest V3 (MV3)**: the current required structure/ruleset Chrome uses for extensions.
- **Content script**: extension JavaScript that runs directly inside a web page (so it can find the video element, read captions, render the overlay).
- **Background service worker**: a separate, page-independent part of the extension, used here to hold the persistent connection to our backend.
- **Offscreen document**: a hidden page MV3 extensions create when they need browser features (like processing raw audio) that a service worker can't touch directly.
- **WebSocket**: an internet connection that stays open continuously so both sides can send messages instantly, at any time, without repeatedly asking "anything new?"
- **Backend / server**: the program doing the heavy thinking (speech-to-text, claim detection, research, verdicts). Runs separately from the browser — for this version, on the developer's own laptop.
- **STT (Speech-to-Text)**: technology that turns spoken audio into written text.
- **LLM (Large Language Model)**: an AI model that reads/writes text and reasons about it.
- **NVIDIA NIM**: NVIDIA's platform offering various AI models over a free API (`build.nvidia.com`), so the project doesn't need its own powerful hardware.
- **API / API key**: a way for one program to ask another (often on someone else's servers) to do something. The key is like a password that identifies the requester, used for tracking usage and limits.
- **Rate limit**: a cap on requests-per-minute for a given API key. NVIDIA's free tier is roughly 40 requests/minute.
- **Agent**: one focused use of an LLM, given a specific job and (often) tools it can use, like web search.
- **Tool calling**: an LLM's ability to trigger a real action (e.g. a web search) mid-task before finishing its answer.
- **Claim detection**: deciding whether a sentence is an actual checkable factual claim, versus opinion/joke/filler.
- **Debate round**: agents that researched the same claim separately are shown each other's findings once, and each may revise its own conclusion.
- **Judge (model)**: the final, strongest LLM call. Reads everything the research agents found and writes the single final verdict.
- **Verdict**: the final answer for a claim — always exactly one of: `supported`, `contradicted`, `mixed`, `unverifiable`.
- **Embedding**: text converted into a list of numbers representing its meaning, so two pieces of text can be compared for similarity even if worded differently.
- **Cache**: stored results of past work, reused instantly instead of redoing it.
- **SQLite**: a simple, file-based database — no separate server process, just one file on disk.
- **sqlite-vec**: an SQLite extension that adds embedding storage + similarity search directly inside the same simple file.
- **Pydantic AI**: a Python library used to build the agents — connects to NVIDIA's models via a custom endpoint, limits concurrency, and forces LLM output into a clean, validated structure (a Python class/schema) instead of loose text.
- **Structured output**: forcing an LLM's answer into a predefined shape (specific fields, specific types) instead of free-form prose.
- **Concurrency limiter**: caps how many requests can be in-flight to an API at once.
- **Queue / worker pool**: a waiting line of work items (claims) plus a small fixed number of workers that pull from it one at a time, so work is throttled instead of overwhelming the rate limit.
- **VAD (Voice Activity Detection)**: lightweight software that detects when someone is actually speaking versus silence, so audio is split into complete spoken phrases, not random time slices.
- **State machine**: a model of something (here: a single claim) that's always in exactly one of a fixed list of states, and only allowed to move between them in specific, defined ways.
- **Schema**: a precise definition of what fields a piece of data (like a JSON message) must contain and what type each field is.

---

## 4. Who this is for

**Version 1 (this build):** A single person — the developer — running the extension and backend on their own laptop, for personal use.

**Explicitly deferred:** publishing for other users (see section 6 — Non-goals).

---

## 5. Goals for this version

- Automatically read audio/captions from whatever video is open in the active tab.
- Detect which spoken sentences are checkable factual claims.
- Run each new claim through a multi-agent research-and-debate process to reach a verdict.
- Display claims and verdicts in an on-page overlay per `BRAND_GUIDE.md`.
- Avoid redoing work for claims that have effectively already been checked, even if reworded differently.
- Stay within NVIDIA's free API tier at all times.
- Run entirely on the developer's own laptop, no paid hosting.

## 6. Non-goals for this version (explicitly NOT building yet)

- Multiple simultaneous users or a public install base.
- A "bring your own API key" system.
- Cloud hosting / an always-on server.
- Any browser other than Chrome/Chromium MV3.
- Any language other than English.
- A mobile app.
- User accounts, logins, or payments.

---

## 7. High-level system overview (the full story, start to finish)

1. User opens a video on a page with the extension active.
2. Content script checks the video element for an existing caption track.
3. **Captions exist:** read caption text directly as it streams. Fast, free, no extra processing.
4. **No captions:** content script triggers tab audio capture via the offscreen document; audio is split into natural phrases using voice activity detection, then sent to the backend.
5. Either way, text flows continuously from the background service worker to the backend over one open WebSocket connection.
6. Backend buffers text into a rolling window (~15–30 seconds) and sends that window in one batched call to a small, fast model that flags any checkable claims inside it.
7. For each flagged claim: compute its embedding, search the local semantic cache for a close match.
   - **Match found:** return the cached verdict immediately. Skip everything below.
   - **No match:** continue.
8. Claim is placed on an internal queue; a small fixed pool of workers pulls claims one at a time (this, plus a concurrency limiter on the model calls, is what protects NVIDIA's rate limit).
9. Three research agents run at once (different angles: general news, official/government data, fact-checking sites), each with a web search tool, each producing a structured first-draft position.
10. All three drafts are shared with each agent for one single debate round; each may revise its position.
11. A stronger "judge" model reads all three revised positions and produces the final structured verdict (category + explanation + sources).
12. Verdict is saved to the cache (with the claim's embedding) and sent to the extension over the WebSocket.
13. The overlay updates the matching claim card from "Checking…" to its final colored verdict state; clicking it shows the explanation and sources.

---

## 8. Project file/folder structure

Use this exact structure. An AI coding agent should create these files/folders as the skeleton before writing implementation logic.

```text
factcheck-ai/
├── extension/
│   ├── manifest.json
│   ├── background/
│   │   └── service-worker.js        # holds the WebSocket, sends keepalive, relays messages
│   ├── content/
│   │   ├── content-script.js        # finds video, reads captions, renders overlay
│   │   └── overlay.css              # Shadow DOM styles, built from BRAND_GUIDE.md tokens
│   ├── offscreen/
│   │   ├── offscreen.html
│   │   └── offscreen.js             # tab audio capture + VAD chunking
│   ├── popup/
│   │   ├── popup.html               # Feed / Sources / Settings tabs
│   │   ├── popup.js
│   │   └── popup.css
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
├── backend/
│   ├── main.py                      # FastAPI app, WebSocket endpoint
│   ├── config.py                    # loads env vars (API keys, thresholds, etc.)
│   ├── session.py                   # per-connection session state, rolling transcript buffer
│   ├── stt.py                       # Parakeet calls
│   ├── claim_detection.py           # Nemotron Nano batched calls, structured output
│   ├── cache.py                     # SQLite + sqlite-vec read/write, similarity search
│   ├── queue_manager.py             # asyncio.Queue + worker pool
│   ├── agents/
│   │   ├── research_agent.py        # the 3-angle research agents (Nemotron Super + search tool)
│   │   ├── debate.py                # the single debate/revision round
│   │   └── judge.py                 # final verdict call (Nemotron Ultra)
│   ├── schemas.py                   # all Pydantic models (messages + structured LLM outputs)
│   ├── requirements.txt
│   └── .env.example
├── PRD.md
├── PROMPT.md
└── BRAND_GUIDE.md
```

---

## 9. Claim lifecycle (state machine)

Every detected claim moves through exactly these states, in this order, never skipping or reversing:

| State | Meaning | What causes the transition into this state | Message sent to extension at this point |
|---|---|---|---|
| `detected` | Claim text identified by the claim-detection model | Claim-detection batch call returns this claim | none (internal only) |
| `cache_check` | Looking up a semantic match in the cache | Immediately after `detected` | none (internal only) |
| `checking` | Cache miss confirmed; about to start full pipeline | No close cache match found | `status_update`, `status: "checking"` |
| `researching` | Three agents researching in parallel | Worker picks claim off the queue and starts the pipeline | `status_update`, `status: "researching"` |
| `debating` | Agents revising after seeing each other's drafts | All three first drafts completed | `status_update`, `status: "debating"` |
| `done` | Final verdict produced | Judge model returns a verdict | `verdict_update` |

If a cache match **is** found during `cache_check`, the claim skips straight from `cache_check` to `done`, sending a `verdict_update` with `"cached": true`, and never enters `checking`/`researching`/`debating` at all.

---

## 10. WebSocket message schemas (exact formats — use these field names and types exactly)

All messages are JSON objects with a `type` field.

### 10.1 Extension → Backend

**Caption text chunk:**
```json
{
  "type": "caption_chunk",
  "session_id": "abc123",
  "text": "unemployment is at its lowest in fifty years",
  "timestamp_ms": 1719500000000
}
```

**Audio chunk (only sent when no captions are available):**
```json
{
  "type": "audio_chunk",
  "session_id": "abc123",
  "audio_base64": "<base64-encoded audio bytes, one VAD-segmented phrase>",
  "format": "wav",
  "timestamp_ms": 1719500000000
}
```

**Keepalive (sent every 20 seconds to keep the service worker alive):**
```json
{ "type": "keepalive" }
```

### 10.2 Backend → Extension

**Status update (claim entering checking / researching / debating):**
```json
{
  "type": "status_update",
  "claim_id": "claim_0001",
  "claim_text": "unemployment is at its lowest in fifty years",
  "status": "researching"
}
```
`status` must be one of: `"checking"`, `"researching"`, `"debating"`.

**Final verdict:**
```json
{
  "type": "verdict_update",
  "claim_id": "claim_0001",
  "claim_text": "unemployment is at its lowest in fifty years",
  "verdict": "mixed",
  "explanation": "Unemployment is near a multi-decade low but official data does not support 'lowest in fifty years' specifically.",
  "sources": [
    { "title": "Bureau of Labor Statistics report", "url": "https://example.gov/...", "domain": "bls.gov" },
    { "title": "Reuters coverage", "url": "https://example.com/...", "domain": "reuters.com" }
  ],
  "cached": false
}
```
`verdict` must be one of: `"supported"`, `"contradicted"`, `"mixed"`, `"unverifiable"`.

**Error (something failed but the claim still resolves, per resilience rules in section 12):**
```json
{
  "type": "error",
  "claim_id": "claim_0001",
  "message": "one research agent timed out; verdict produced with reduced confidence"
}
```

---

## 11. Detailed requirements — Browser Extension (frontend)

### 11.1 Structure
- Manifest V3, minimum Chrome version **116** (this specific version is required because Chrome 116 introduced the fix where an active WebSocket connection keeps the background service worker from being shut down — this project depends on that behavior).
- Four parts, matching the file structure in section 8: content script, background service worker, offscreen document, popup.

### 11.2 Caption detection behavior
- On video load, and again whenever the video element changes (important for SPA-style sites like YouTube where a new video loads without a full page reload), check for an existing caption/text track.
- If found: read text as it streams; send each new piece as a `caption_chunk` message (section 10.1).
- **Acceptance criteria:** Given a video with an available caption track, when the video plays, then caption text must be sent to the backend within 1 second of appearing, and audio capture must never be triggered.

### 11.3 Audio capture fallback behavior
- If no caption track is found, request tab audio capture and start capturing.
- Hand the raw stream to the offscreen document.
- Offscreen document uses voice activity detection to find natural pauses, sending only complete spoken phrases as `audio_chunk` messages — never fixed-length time slices.
- **Acceptance criteria:** Given a video with no caption track, when it plays, then `audio_chunk` messages must contain complete phrases (start and end at detected silence), not arbitrary time-based cuts.

### 11.4 WebSocket client behavior
- Background service worker opens one WebSocket connection while the extension is active.
- Sends a `keepalive` message every 20 seconds.
- Automatically attempts to reconnect if the connection drops.
- **Acceptance criteria:** Given the extension is active for longer than the default Chrome service-worker idle timeout, when no other messages are flowing, then the keepalive messages must keep the connection (and service worker) alive without manual user action.

### 11.5 Overlay UI behavior
- Rendered inside a Shadow DOM, styled per `BRAND_GUIDE.md` exactly.
- Claim cards follow the state machine in section 9: `Checking…` → `Researching…` → `Debating…` → final verdict, color-coded per the brand guide's verdict-to-color map.
- Each card is collapsed by default (claim text + current/final status); "View Details" expands it to show explanation + sources.
- A toggle in Settings turns the whole feature on/off.
- **Acceptance criteria:** Given a `status_update` or `verdict_update` message arrives for a `claim_id` already shown in the overlay, when it's received, then the existing card for that `claim_id` must update in place — a new duplicate card must never be created for the same `claim_id`.

---

## 12. Detailed requirements — Backend Server

### 12.1 Technology
- Python, FastAPI (chosen specifically for native WebSocket support).
- Pydantic AI for all agents (chosen specifically for: custom-endpoint support for NVIDIA, a built-in concurrency limiter, and forced structured output).
- NVIDIA NIM free API for every model call.
- One personal NVIDIA API key for this version (multi-key support is out of scope — section 6).
- **Hard constraint to design around:** NVIDIA's free tier is approximately **40 requests per minute, per API key**. Every part of the backend (batched claim detection, the semantic cache, the queue/worker pool) exists specifically to keep total usage under this ceiling. See section 19 for the full reasoning behind every technology choice in this section, including why each alternative considered was rejected.

### 12.2 NVIDIA model roles

| Role | Model family to use | Input | Output (structured, via Pydantic AI) |
|---|---|---|---|
| Claim detection | Nemotron **Nano** (smallest/fastest) | A transcript text window | List of claim strings found in that window |
| Research agents (×3, run in parallel) | Nemotron **Super** (tool-calling capable) | One claim + a research angle + a search tool | `{ stance, confidence, evidence_summary, sources[] }` |
| Judge (final verdict) | Nemotron **Ultra** (strongest reasoning) | All 3 revised agent positions | `{ verdict, explanation, sources[] }` |
| Speech-to-text | Parakeet | One VAD-segmented audio chunk | Transcribed text |
| Embeddings (for the cache) | An NVIDIA embedding model | A claim's text | A numeric embedding vector |

> Exact model ID strings (e.g. `nvidia/llama-3.3-nemotron-super-49b-v1`) should be confirmed directly in the current NVIDIA catalog before coding, since version numbers change. Do not hardcode an ID without checking it's still current and still on the free tier.

### 12.3 Speech-to-text pipeline
- Each incoming `audio_chunk` (already one VAD-segmented phrase) is sent to Parakeet for transcription.
- Resulting text is appended to that session's rolling transcript buffer (same buffer used for caption text).

### 12.4 Claim detection (pseudocode)
```python
WINDOW_SECONDS = 20  # tune during development

async def transcript_buffer_loop(session):
    while session.active:
        await asyncio.sleep(WINDOW_SECONDS)
        window_text = session.pop_buffer()
        if not window_text.strip():
            continue
        claims = await detect_claims(window_text)  # ONE Nemotron Nano call, structured output: list[str]
        for claim_text in claims:
            await handle_new_claim(claim_text, session)
```
- **Rule:** this must be ONE call per window, covering all new text since the last window — never one call per individual sentence. This batching is required to protect the NVIDIA rate limit.
- **Acceptance criteria:** Given a 20-second window containing three sentences where only one is a checkable factual claim, when claim detection runs, then exactly one claim string must be returned and the other two sentences must be discarded — and this must happen in a single model call, not three.

### 12.5 Semantic cache (pseudocode)
```python
SIMILARITY_THRESHOLD = 0.85  # tune during development; higher = stricter match required

async def handle_new_claim(claim_text, session):
    embedding = await embed_text(claim_text)
    match = cache.find_similar(embedding, threshold=SIMILARITY_THRESHOLD)

    if match:
        await send_to_extension(verdict_update_from_cache(match, claim_text))
        return  # pipeline below is skipped entirely

    claim_id = generate_claim_id()
    await send_to_extension(status_update(claim_id, claim_text, "checking"))
    await processing_queue.put((claim_id, claim_text, embedding))
```
- Storage: one SQLite file extended with `sqlite-vec` (no separate database server).
- Table must store at minimum: claim text, embedding, verdict category, explanation, sources (JSON), timestamp (full schema in section 13).
- **Acceptance criteria:** Given a claim is checked once and stored, when a differently-worded claim with the same underlying meaning is later detected, then it must return the cached verdict if its embedding similarity is above `SIMILARITY_THRESHOLD`, without starting any research agents.

### 12.6 Queue and worker pool (pseudocode)

**Why this exists, with the actual math:** a single new (non-cached) claim costs roughly 6–8 NVIDIA API calls total — 3 research calls, 3 debate-revision calls, 1 judge call, plus its share of the batched claim-detection call. Against the ~40-requests-per-minute ceiling (section 12.1), that means the system can fully resolve only a handful of brand-new claims per minute, even before any STT or embedding calls are counted. The queue and a small fixed worker count don't remove this ceiling — nothing can — they just make the system queue claims gracefully instead of every call failing at once when the limit is hit. The semantic cache (section 12.5) is what actually keeps this workable in practice, since most repeated political talking points get served instantly with zero NVIDIA calls after the first time they're checked.

```python
NUM_PIPELINE_WORKERS = 2  # ⚠ NOT YET DECIDED — starting point only, see note below

async def worker_loop():
    while True:
        claim_id, claim_text, embedding = await processing_queue.get()
        try:
            verdict = await run_pipeline(claim_id, claim_text)
            cache.store(claim_text, embedding, verdict)
            await send_to_extension(verdict_update(claim_id, claim_text, verdict, cached=False))
        except Exception as e:
            await send_to_extension(error_update(claim_id, str(e)))

def start_workers():
    for _ in range(NUM_PIPELINE_WORKERS):
        asyncio.create_task(worker_loop())
```

### 12.7 Research → debate → judge pipeline (pseudocode)
```python
async def run_pipeline(claim_id, claim_text):
    await send_to_extension(status_update(claim_id, claim_text, "researching"))

    raw_drafts = await asyncio.gather(
        research_agent("general_news", claim_text),
        research_agent("official_data", claim_text),
        research_agent("fact_check_sites", claim_text),
        return_exceptions=True
    )
    successful_drafts = [d for d in raw_drafts if not isinstance(d, Exception)]
    # See section 12.8 for what happens if successful_drafts is fewer than 3.

    await send_to_extension(status_update(claim_id, claim_text, "debating"))
    revised_drafts = await asyncio.gather(*[
        revise_with_debate(draft, successful_drafts) for draft in successful_drafts
    ])

    verdict = await judge(claim_text, revised_drafts)
    return verdict
```
- Each `research_agent(angle, claim_text)` call is a Pydantic AI agent using the Nemotron Super model plus a web search tool (Tavily or DuckDuckGo), returning a structured draft (section 12.2 output shape).
- The debate round shows each agent the **other two** drafts (not its own) and asks it to revise its own stance.
- The judge call uses Nemotron Ultra and must return the exact structured shape in section 10.2's `verdict_update` (`verdict`, `explanation`, `sources`).

### 12.8 Error handling and resilience requirements
- If one research agent fails (timeout/error), the judge step still proceeds using whichever drafts succeeded (minimum: 1 of 3), and the resulting verdict's explanation should note reduced confidence due to fewer sources of research.
- If **all three** research agents fail, the claim should resolve to `unverifiable` with an explanation noting the research step failed, rather than crashing or silently dropping the claim.
- If a single audio chunk fails to transcribe, skip it and continue listening — never end the whole session over one failed chunk.
- If the WebSocket connection drops mid-pipeline, claims already in the queue/pipeline must still complete and be held (not discarded); they should be sent once the connection re-establishes.
- **Acceptance criteria:** Given exactly one of the three research agents throws an exception, when the pipeline continues, then a `verdict_update` must still be produced using the other two agents' positions, and it must not be left in a `researching` or `debating` state indefinitely.

---

## 13. Data model (database schema)

Single SQLite file (`factcheck.db`), extended with `sqlite-vec`, one table:

| Column | Type | Description |
|---|---|---|
| `id` | integer, primary key | Unique row identifier. |
| `claim_text` | text | The factual claim as originally detected. |
| `embedding` | vector (via sqlite-vec) | Numeric embedding of `claim_text`, used for similarity search. |
| `verdict` | text | One of: `supported`, `contradicted`, `mixed`, `unverifiable`. |
| `explanation` | text | Short written explanation from the judge model. |
| `sources` | text (JSON array) | List of `{ "title", "url", "domain" }` objects. |
| `created_at` | timestamp | When this verdict was first produced. |

**Example row (illustrative, not literal data to ship):**
```json
{
  "id": 1,
  "claim_text": "unemployment is at its lowest in fifty years",
  "embedding": [0.0123, -0.0456, "... many more numbers ..."],
  "verdict": "mixed",
  "explanation": "Unemployment is near a multi-decade low but official data does not confirm the specific 'fifty years' figure.",
  "sources": [
    { "title": "Bureau of Labor Statistics report", "url": "https://example.gov/...", "domain": "bls.gov" }
  ],
  "created_at": "2026-06-28T12:00:00Z"
}
```

---

## 14. Environment variables

These must be loaded from environment configuration (e.g. a `.env` file), never hardcoded. The values below are split into two groups — don't treat the second group as already-decided numbers, they are starting points only:

**Genuinely required, no default possible:**
```text
NVIDIA_API_KEY=               # required — your personal free NVIDIA NIM key
TAVILY_API_KEY=                # required only if using Tavily instead of DuckDuckGo for search
DATABASE_PATH=./factcheck.db
```

**⚠ NOT YET DECIDED — these were never explicitly agreed on; the numbers below are starting points to tune while testing, not a finalized decision:**
```text
SIMILARITY_THRESHOLD=0.85       # cache match strictness — too low = false cache hits on unrelated claims, too high = real repeats miss the cache
CLAIM_DETECTION_WINDOW_SECONDS=20   # how much transcript to batch before one claim-detection call
NUM_PIPELINE_WORKERS=2          # how many claims can be mid-pipeline at once — directly trades off speed against the 40rpm ceiling (section 12.1)
```

---

## 15. Non-functional requirements

- **Latency:** a 5–20 second delay between a claim being spoken and a verdict appearing is acceptable. Correctness matters more than instant speed.
- **Cost:** must run within NVIDIA's free tier for this version. No paid usage expected.
- **Hosting:** the developer's own laptop. No cloud hosting required.
- **Security:** the NVIDIA API key lives only in backend environment configuration — never sent to or exposed in the browser extension.
- **Privacy:** audio/caption data is sent only to NVIDIA's API (for transcription/LLM calls) and the chosen search tool. No other third parties.

---

## 16. Out of scope for this version (recap)

- Multi-user support, public release, "bring your own API key."
- Paid or cloud hosting.
- Any language other than English.
- Any browser other than Chrome/Chromium MV3.

## 17. Future considerations (not built now, but worth remembering)

- If/when published for other users: revisit the API key strategy — per-user free keys, or a paid centrally-managed key with cost controls.
- Move the backend off a personal laptop to an always-on server once real users depend on availability.
- Additional languages and caption/audio sources beyond English.

---

## 18. Definition of done for this version

All of the following must be true:
- [ ] A user can open a political video on YouTube (with or without captions) in Chrome with the extension installed and active.
- [ ] Within roughly 5–20 seconds of a factual claim being spoken, a claim card appears in the overlay.
- [ ] That card progresses visibly through `Checking…` → `Researching…` → `Debating…` → a final colored verdict (or jumps straight to a cached verdict if one already exists).
- [ ] The final verdict shows real, clickable sources.
- [ ] Repeated/rephrased claims across different videos return cached verdicts instantly instead of re-running the full pipeline.
- [ ] The system never exceeds NVIDIA's free-tier rate limit during normal use.
- [ ] No server other than the developer's own laptop is required.

---

## 19. Why these technology decisions were made (full rationale, for anyone with no memory of the original discussion)

This section exists so an AI coding agent or new developer reading only this file — with no access to the conversation where these choices were actually made — understands not just *what* to build but *why*, and doesn't substitute a "better-sounding" alternative that was already considered and rejected for a specific reason.

### 19.1 Why NVIDIA NIM instead of Claude, OpenAI, or another paid LLM provider
The project must run entirely on a free tier, with no ongoing API cost. NVIDIA NIM (`build.nvidia.com`) offers a meaningful free tier across text models, an embedding model, and a speech-to-text model (Parakeet), all through one account. Its API is OpenAI-compatible, meaning standard Python tooling (the `openai` library, or libraries built on top of it like Pydantic AI) works against it by changing only the base URL and key — no proprietary SDK lock-in. The one real cost of this choice: NVIDIA's models do not include built-in web search the way some other providers' APIs do, which is why a separate search tool (Tavily or DuckDuckGo) is required for the research agents.

### 19.2 Why Pydantic AI, and specifically why not LangGraph, CrewAI, AutoGen, or plain raw code
Four options were directly compared for building the three-agent research/debate/judge pipeline:
- **Plain Python with the `openai` library and `asyncio`, no framework at all** — full control over exactly how many calls happen, which matters most given the ~40 requests/minute ceiling, and the simplest thing to build for a small, fixed pipeline shape (three agents, one debate round, one judge). This was the *initial* recommendation before a better-fitting option was found.
- **LangGraph** — fully model-agnostic, the most token-efficient of the named frameworks, gives explicit graph-based control. Genuinely good, but has the steepest learning curve of the options for a pipeline this small and fixed-shape — most of its power (complex branching, long-running state) isn't needed here.
- **CrewAI** — easiest framework to learn, but specifically risky for this project because of documented friction integrating non-OpenAI custom endpoints (exactly what NVIDIA NIM is), with reports of upgrades breaking those integrations unexpectedly.
- **AutoGen** — conceptually the closest match, since it's literally built around agents debating each other. Rejected for two concrete reasons: (1) it has been placed into maintenance mode by its maintainer in favor of a different framework, meaning less future support, and (2) its group-conversation style resends the entire accumulated conversation history on every agent turn, making it the *most* expensive of all options in calls/tokens used — directly working against the 40rpm ceiling this whole system is designed around.
- **Pydantic AI — the final choice.** It beats even the "plain raw code" option for three concrete reasons: (1) it has explicit, documented support for pointing at a custom OpenAI-compatible endpoint via a `Provider` class — exactly the NVIDIA NIM integration pattern, not a workaround; (2) it ships a `ConcurrencyLimitedModel` wrapper specifically for limiting concurrent in-flight requests to a model, which is a direct, built-in answer to the rate-limit problem that every other option would require hand-rolling; (3) it pairs naturally with a FastAPI backend, since its structured output type can double as the API response model, removing an entire layer of manual text-parsing for verdicts and claim lists that would otherwise be needed and would be fragile.

### 19.3 Why plain HTML/CSS/vanilla JavaScript for the extension, not React
A build-free extension is easier to load, test, and debug while the harder backend pieces are still being built. The overlay's actual UI complexity is low — a list of claim cards that change state over time — which plain JavaScript handles fine via DOM updates triggered by incoming WebSocket messages. Migrating to a framework later remains an option if the UI grows significantly more complex, but starting simple removes one variable while debugging the agent pipeline, which is the harder and riskier part of the system.

### 19.4 Why the WebSocket connection lives in the background service worker, with a 20-second keepalive, and why Chrome 116 is the minimum version
Manifest V3 background service workers are not persistent by default — Chrome can shut them down after a period of inactivity. As of Chrome 116, an active WebSocket connection extends the service worker's idle timer, and sending a small keepalive message over that socket every 20 seconds is the documented way to keep it alive indefinitely. This is what makes holding the one persistent connection to the backend in the service worker (rather than the content script, which dies whenever the user navigates away) both correct and reliable, and it's why 116 is set as the minimum supported Chrome version rather than an arbitrary number.

### 19.5 Why hybrid speech-to-text (captions first, audio capture as fallback), and why voice-activity-detection-based chunking instead of fixed time slices
Many videos (most notably YouTube) already have caption tracks, which are free and instant to read directly — there's no reason to do expensive audio transcription when the text is already available on the page. Audio capture and NVIDIA's Parakeet model exist purely as the fallback for sites without captions. When audio capture is needed, chunking by a fixed time interval (e.g. every 3 seconds) routinely cuts sentences in half mid-word, producing poor transcriptions right at the boundaries. Voice activity detection instead waits for a natural pause in speech before sending a chunk, so each chunk sent to Parakeet is a complete spoken phrase.

### 19.6 Why claim detection is batched into a rolling window instead of called per sentence
Calling the claim-detection model once for every individual sentence as it streams in would multiply the number of API calls dramatically for no benefit, directly working against the ~40-requests-per-minute ceiling (section 12.1). Batching roughly 15–30 seconds of new transcript text into a single call, and asking the model to return a structured list of whichever parts (if any) are checkable claims, accomplishes the same filtering in a fraction of the calls.

### 19.7 Why the cache is semantic (embedding similarity) instead of exact text matching, and why SQLite + sqlite-vec instead of a dedicated vector database
The same political claim is almost never repeated with identical wording — it gets rephrased differently by different speakers and different videos. An exact-text cache would therefore miss nearly all real repeats, defeating the purpose of caching at all. Comparing claims by the similarity of their embeddings catches these rewordings. A dedicated vector database server (Pinecone, Weaviate, Qdrant, etc.) would be real overkill for a single laptop, single user, and a modest claim volume — `sqlite-vec` provides the same core similarity-search capability as a lightweight extension to the same SQLite file already being used for everything else, with zero additional infrastructure to run or maintain.

### 19.8 Why this version uses one personal NVIDIA API key instead of building a "bring your own key" system now
The project owner does want to eventually let other people use this extension, but that is explicitly a future step, not part of this version. Building a multi-user key system, per-user onboarding flow, and the cost/scaling logic that would come with real concurrent users is real engineering effort that has no value yet for a project currently used by exactly one person. The single-key approach is intentionally the simplest thing that works for the current scope; section 17 records the two real options (per-user keys, or a centrally paid key) to revisit specifically when publishing actually becomes the next real step, not before.

