# Build Prompt — FactCheck AI

This file is meant to be given directly to an AI coding agent (such as Claude Code) as the instructions for building this project. It is written as a direct instruction to that agent.

---

## Who you are and what you're building

You are building **FactCheck AI**, a Chrome browser extension paired with a Python backend. The extension listens to whatever video is playing in the active browser tab, detects spoken factual claims, sends them to the backend to be researched by a team of AI agents, and displays the resulting verdict (Supported / Contradicted / Mixed / Unverifiable) in an on-page overlay.

**Before writing a single line of code, read these two files fully:**
1. `PRD.md` — the complete requirements, including exact WebSocket message schemas (section 10), the claim state machine (section 9), the database schema (section 13), pseudocode for the trickiest logic (sections 12.4–12.7), **and the full reasoning behind every technology choice below in section 19** — read that section before substituting any tool or library for one you think is "better," since the alternatives were already considered.
2. `BRAND_GUIDE.md` — exact colors, fonts, spacing, CSS variables, and component markup for anything visual. Never invent a new color, font size, spacing value, or shadow that isn't already defined there.

If something you need to build is not covered clearly by either file, **stop and ask a clarifying question** rather than guessing or inventing behavior on your own.

---

## Technology stack (use exactly this, do not substitute)

**Browser extension (frontend):**
- Manifest V3, minimum Chrome version 116.
- Plain HTML, CSS, and vanilla JavaScript. No React, no build tools, no bundler.
- Four parts: content script, background service worker, offscreen document (audio capture only), popup (Feed / Sources / Settings).
- Overlay UI rendered inside a Shadow DOM.

**Backend:**
- Python, FastAPI (WebSocket endpoint).
- Pydantic AI for all agents and structured outputs.
- NVIDIA NIM free API (`build.nvidia.com`) for every model call: Nemotron Nano (claim detection), Nemotron Super (the three research agents), Nemotron Ultra (the judge), Parakeet (speech-to-text), an NVIDIA embedding model (semantic cache).
- A web search tool for the research agents (Tavily or DuckDuckGo).
- SQLite + sqlite-vec for the local cache. No external database server.
- Python's `asyncio` for parallel agents and the internal queue. Do not introduce Celery, Redis, or any other heavier task-queue system — unnecessary for a single-user, single-laptop project.

**Exact file structure to create** (see `PRD.md` section 8 for the full annotated version):
```text
factcheck-ai/
├── extension/
│   ├── manifest.json
│   ├── background/service-worker.js
│   ├── content/content-script.js
│   ├── content/overlay.css
│   ├── offscreen/offscreen.html
│   ├── offscreen/offscreen.js
│   ├── popup/popup.html
│   ├── popup/popup.js
│   └── popup/popup.css
├── backend/
│   ├── main.py
│   ├── config.py
│   ├── session.py
│   ├── stt.py
│   ├── claim_detection.py
│   ├── cache.py
│   ├── queue_manager.py
│   ├── agents/research_agent.py
│   ├── agents/debate.py
│   ├── agents/judge.py
│   ├── schemas.py
│   ├── requirements.txt
│   └── .env.example
├── PRD.md
├── PROMPT.md
└── BRAND_GUIDE.md
```

---

## Build order, with a Definition of Done checklist for each phase

Build in this order. Each phase must be **fully working and testable** before starting the next one.

### Phase 1 — Extension skeleton
Build the Manifest V3 shell: content script, background service worker, offscreen document, popup — no real logic yet.

Skeleton to start from:
```javascript
// background/service-worker.js
let socket = null;

function connect() {
  socket = new WebSocket("ws://localhost:8000/ws");
  socket.onopen = () => setInterval(() => socket.send(JSON.stringify({ type: "keepalive" })), 20000);
  socket.onclose = () => setTimeout(connect, 1000); // auto-reconnect
  socket.onmessage = (event) => { /* relay to content script — fill in Phase 3+ */ };
}
connect();
```

**Definition of Done for Phase 1:**
- [ ] Extension loads in Chrome with no errors in `chrome://extensions`.
- [ ] Background service worker opens a WebSocket connection.
- [ ] Sending a `keepalive` message every 20 seconds is confirmed (e.g. via backend logs) without the service worker being killed, even after several minutes idle.

### Phase 2 — Backend skeleton
Build the FastAPI app with one WebSocket endpoint that echoes back whatever it receives.

Skeleton to start from:
```python
# main.py
from fastapi import FastAPI, WebSocket

app = FastAPI()

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    while True:
        data = await websocket.receive_json()
        await websocket.send_json(data)  # echo — replace with real handling in later phases
```

**Definition of Done for Phase 2:**
- [ ] Backend starts with `uvicorn main:app`.
- [ ] Extension (Phase 1) connects to it successfully and a test message sent from the extension is echoed back and visible in the extension's console.

### Phase 3 — Caption and audio capture
Implement caption track detection/reading in the content script. Implement the audio capture fallback (tab capture → offscreen document → VAD chunking) for sites without captions.

**Definition of Done for Phase 3:**
- [ ] On a video with captions (e.g. YouTube), `caption_chunk` messages (per `PRD.md` section 10.1) are sent to the backend and visible in backend logs as the video plays.
- [ ] On a video with no captions, `audio_chunk` messages are sent instead, each containing one complete VAD-segmented phrase, not a fixed-length slice.

### Phase 4 — Speech-to-text
Wire up the Parakeet model call so audio chunks from Phase 3's fallback path get transcribed.

**Definition of Done for Phase 4:**
- [ ] An `audio_chunk` message results in readable transcribed text appearing in the session's transcript buffer (log it for now to confirm).

### Phase 5 — Claim detection
Implement the rolling transcript buffer and the batched call to Nemotron Nano (see `PRD.md` section 12.4 for exact pseudocode), using Pydantic AI structured output so claims come back as a clean list.

**Definition of Done for Phase 5:**
- [ ] A 20-second window of transcript text containing one real claim and some filler/opinion text results in exactly one claim being detected, in exactly one model call (confirm via logging the number of API calls made).

### Phase 6 — Semantic cache
Set up SQLite + sqlite-vec (schema in `PRD.md` section 13). Implement embedding + similarity search before the full pipeline runs, and storing new verdicts after.

**Definition of Done for Phase 6:**
- [ ] Checking the same claim twice (worded identically) returns a cached result the second time with no agents started.
- [ ] Checking a **differently worded** claim with the same meaning (e.g. rephrase a test claim) also returns the cached result, confirming the similarity threshold works, not just exact text matching.

### Phase 7 — Research and debate pipeline
Implement the queue/worker pool (section 12.6), the three parallel research agents (section 12.7), the debate round, and the judge call. Wire in `status_update` messages at each stage transition per the state machine in `PRD.md` section 9. **Read `PRD.md` section 12.1 and 12.6 before picking a worker count** — it's not an arbitrary number, it's a direct tradeoff against NVIDIA's ~40-requests-per-minute limit.

**Definition of Done for Phase 7:**
- [ ] A brand-new (not cached) claim triggers, in order: a `checking` status, a `researching` status, a `debating` status, then a `verdict_update` with a valid verdict category, explanation, and at least one source.
- [ ] Manually breaking one research agent (e.g. temporarily forcing it to throw) still results in a final verdict being produced using the other two — confirming the resilience rule in `PRD.md` section 12.8.

### Phase 8 — Overlay UI polish
Build the actual claim card UI using `BRAND_GUIDE.md` exactly: state-based colors, the pill badges, expandable "View Details," and the Feed/Sources/Settings popup tabs.

**Definition of Done for Phase 8:**
- [ ] Every color, font size, spacing value, and corner radius used in the UI traces back to a named token in `BRAND_GUIDE.md` — none invented.
- [ ] A `status_update` or `verdict_update` for an existing `claim_id` updates that card in place rather than creating a duplicate.

### Phase 9 — Error handling pass
Go back through every phase and verify the resilience behaviors in `PRD.md` section 12.8: judge proceeds if a research agent fails, bad audio chunks are skipped without ending the session, WebSocket reconnects gracefully without losing queued claims.

**Definition of Done for Phase 9:**
- [ ] All resilience acceptance criteria listed throughout `PRD.md` (sections 11.2–11.5 and 12.4–12.8) have been manually verified at least once.

---

## Rules to follow throughout (anti-patterns to avoid)

- Keep functions small and single-purpose; comment non-obvious logic.
- Never hardcode the NVIDIA API key or any secret — load from environment variables only (see `PRD.md` section 14 for the exact variable names expected).
- Never invent a UI color, font, or spacing value — trace every visual decision to `BRAND_GUIDE.md`.
- Never add features, libraries, or architecture not called for in `PRD.md`. Ask before expanding scope.
- Never parse structured data (claim lists, verdicts) with string matching or regular expressions — always use Pydantic AI's structured output typing.
- Never call the claim-detection model once per sentence — always batch a window of text into one call (`PRD.md` section 12.4).
- Never skip the cache check before starting the research pipeline — always check for a semantic match first (`PRD.md` section 12.5).
- Never introduce Celery, Redis, or other heavyweight task-queue infrastructure — `asyncio.Queue` and a small worker pool are sufficient and required (`PRD.md` section 12.6).
- Never build multi-user accounts, a "bring your own key" flow, or cloud deployment config — explicitly out of scope per `PRD.md` section 6.
