SYSTEM CONTEXT: Real-Time Fact-Checker Browser Extension

1. Document Purpose

This document contains the foundational conversation, ideation, and architectural decisions for a real-time political fact-checking browser extension.

Instruction for AI Agents reading this file:
Use this document to understand the project's background, the user's requirements, and the explicit rationale behind the chosen technology stack. Do not deviate from the finalized tech stack listed in Section 2 without explicit user permission.

2. Finalized Architecture & Tech Stack (TL;DR)

Frontend (Browser Extension)

Framework: Plain HTML, CSS, vanilla JavaScript (No React, no build tools).

Core API: Manifest V3 (Chrome, minimum version 116).

Styling: Shadow DOM for style isolation on the overlay.

Audio Capture: Chrome's tabCapture API + an Offscreen Document (fallback when no captions exist).

Communication: WebSocket client, held in the background service worker (kept alive via Chrome 116+ spec).

Backend (Python)

Server: FastAPI (web server + WebSocket endpoint).

Agent Framework: Pydantic AI (handles NVIDIA endpoint rate limiting, structured outputs).

Concurrency: asyncio (internal queue, worker pool, running 3 research agents in parallel).

Database/Cache: SQLite + sqlite-vec extension (semantic cache in one file, no separate DB server).

AI Models (NVIDIA NIM Free API via build.nvidia.com)

Speech-to-Text: Parakeet (audio fallback when no captions).

Claim Detection: Nemotron Nano (fast filter step).

Research/Debate Agents: Nemotron Super (tool-calling, 3 agents in parallel).

Final Judge: Nemotron Ultra (final verdict evaluation).

Embeddings: NVIDIA embedding model (turns claims into vectors for the semantic cache).

External Tools & Environment

Search Tool: Tavily or DuckDuckGo (NVIDIA models lack native search).

Design System: "Veracity Framework" (Inter font, specific color/spacing tokens).

Build Tool: Claude Code running Opus 4.8.

Hosting: Localhost (developer's laptop) for MVP.

3. Full Conversation Transcript

🗣️ User Query 1: Initial Pitch

I am thinking to make fact check thing with will be extentation for browser how it will work will be like it will actively transcibe video form a page which is open in the page it is mostly mad for fact checking political startment like they are liye or not so it will dransbibe and it it feels it is starmnt then it will crall web and find the real trunt and if its tru it will say yes it is tru if it is false then it will point out and say what is real

will use Ilm + agent work flow to make it work like for fact chek it will crall multible webpagest and then you the final words so lets to brainstrom on this replau only in simple text

🤖 AI Response 1: System Blueprint

Action: Architected real-time fact-checking extension with transcription, claim detection and verification flow

This is a solid idea and pretty doable with current tools. Let me break down how I'd think about building it, in plain terms.

The core flow is: capture audio or captions from the video on the page, turn speech into text in near real time, figure out which sentences are actual factual claims worth checking, then run a search verify step, then show a verdict back on the page. Let's go piece by piece.

Getting the text out of the video: Two options. One is real audio capture using the browser tab capture API, then sending audio chunks to a speech to text service. The other option is reading existing captions if the site has them, like YouTube's caption track. This is basically free and faster. Good plan for an MVP is to start with YouTube captions, then add real audio transcription later.

Claim detection: You don't want to fact check every sentence. So after you get a chunk of transcript, you run it through a fast cheap LLM call whose only job is to say: Is this a checkable factual claim, or is it opinion, prediction, joke, filler.

The actual fact check: Once you have a claim, the agent workflow kicks in. Generate a few search queries around the claim, hit a search API, pull back several pages, then have the LLM compare what the sources say against the claim and produce a verdict with the reasoning and links to sources.

Verdict and how to phrase it: Avoid having the tool literally say "he is lying" (legally risky). Use categories like: supported by evidence, contradicted by evidence, partially true/missing context, unverifiable. Always show the sources.

Showing it on the page: An overlay on the video, maybe a small sidebar or floating box, with a running list of claims and their status.

Caching: Keep a database of claim and verdict pairs so you don't redo the same web search work every time.

Cost and speed: Realistically there will be a delay of maybe 5 to 15 seconds between something being said and a verdict appearing.

🗣️ User Query 2: Defining the Backend Flow

like would like to go with the STT comvter then let model chosee is it fact that then it should launch multiple real agents for fact check and then come on one consultation and then writeen the decision and what kind of thing we should go with for frontend and backend ask me question with opations for that

🤖 AI Response 2: Tech Stack Setup

Q: For the backend (the server that runs STT, the agents, and search), what do you want to build it in?
A: Python
Q: How should the speech-to-text part capture the video's audio?
A: Hybrid: captions if available, audio capture as fallback
Q: For the multiple fact-check agents reaching one final decision, which style do you want?
A: Agents debate each other's findings for a round before final verdict

Action: Architected Python backend with multi-agent system

Backend: FastAPI for native async support and built in websocket handling.

Agent Debate Flow: Spin up three agents at once using Python's asyncio so they run in parallel. Each searches a different angle (news, government, academic). Each writes a first draft. In a debate round, all three drafts get shown to each agent to revise their position. A final judge step reads all revised positions and writes the final answer.

Frontend UI: Plain HTML, CSS, and vanilla JavaScript for the overlay is the better fit here to avoid build steps.

🗣️ User Query 3: UI/UX Handoff

give me description and idea of project so I can explain to ul designer in small text

🤖 AI Response 3: Designer Brief

Action: Synthesized focused project brief for designer
Project: Real-time fact checker browser extension
Idea: A browser extension that watches a video playing on a page, listens to what's being said, and automatically fact checks claims as they're spoken, live.
UI Needs:

A floating overlay panel that sits on top of or beside the video. Lightweight.

A list of "claim cards" with states: checking (loading), and a final verdict (color-coded: green/true, red/false, yellow/mixed, gray/unverifiable).

Expandable cards showing brief explanations and source links.

Toggle on/off icon.

Tone: Neutral, trustworthy, calm.

🗣️ User Query 4: Reviewing UI

this is ul and its md [Uploads design system]

🤖 AI Response 4: UI Alignment

Action: Alignment and identified missing color tokens
Looks really solid. The sidebar layout with Feed, Sources, and Settings tabs is smart. The "Checking..." state is a nice touch.
Gap flagged: The design only defined blue and red. It needs explicit success (green) and warning (amber) color tokens added to the system, desaturated to match the existing palette.

🗣️ User Query 5: Framework Selection

so tell me what will be the best way for agent like what we should we use also ans me in text

🤖 AI Response 5: Framework Evaluation

Action: Evaluating API surfaces and architecting optimal agent orchestration strategy
Recommendation: Avoid heavy frameworks like LangGraph, Crew AI, or AutoGen for this specific fixed-shape workflow (3 agents -> debate -> judge). Write it directly with Python's asyncio to avoid overhead, debugging abstraction layers, and high token costs.

🗣️ User Query 6: Choosing NVIDIA NIM

nahh I would like to use nvidea api which is free for like i am talking about what should we use to code agent like which library

🤖 AI Response 6: NVIDIA Integration Strategy

Action: Evaluated NVIDIA NIM integration approaches and rate limit constraints
Because you are using NVIDIA's free API, you are capped at 40 requests per minute.

Model Communication: Use the standard openai Python library pointed at NVIDIA's OpenAI-compatible endpoint.

Search: DuckDuckGo-search or Tavily (NVIDIA models don't have built-in web search).

Framework Warning: Since you have a strict 40 RPM limit, heavy frameworks (like AutoGen) will blow through your limits instantly due to conversation history overhead.

🗣️ User Query 7: Framework Deep Dive

explain me what we llbary we will use for making agnets to do work and find which is the best

🤖 AI Response 7: Framework Ratings

Action: Rated framework options out of 10 based on the 40 RPM limit.

Raw Python/asyncio (9/10): Best control over API limits.

LangGraph (7/10): Good, but overkill for a fixed 3-agent shape.

Crew AI (4/10): Risky due to documented friction with custom non-OpenAI endpoints (like NVIDIA NIM).

AutoGen (3/10): Worst fit due to massive API call overhead per debate round.

🗣️ User Query 8: Pydantic AI Introduction

Is there anything better than lang graph

🤖 AI Response 8: The Pydantic AI Pivot

Action: Positioned Pydantic AI as superior alternative
Yes, Pydantic AI is the optimal choice here.

Directly supports custom endpoints (NVIDIA NIM).

Built-in Rate Limiting: Has a ConcurrencyLimitedModel wrapper to perfectly manage the 40 requests/min NVIDIA limit.

Pairs naturally with FastAPI. Gives you clean, validated verdict outputs via Pydantic models instead of parsing free text.

🗣️ User Query 9: Full System Walkthrough

now think and tell me end to end who it works and discuss plane also aske me question for betterment

🤖 AI Response 9: End-to-End Pipeline

Action: Architected complete system flow
Walked through the system from the content script capturing text/audio -> Websocket -> FastAPI -> SQLite Vec Cache -> Internal asyncio queue -> Pydantic AI Agents -> Tavily Search -> Debate -> Judge -> Websocket response.
Decisions made:

Start as a personal project (run locally, use personal NVIDIA key).

Build caching in from the start to save API calls.

🗣️ User Query 10: Model Selection

So so knew you already, I said. Yeah, And models, we all knew data like... I want you to search for the model. I am not sure for... I mean, web crawling, which model you use, and for deciding which, like, It is a fact, what... which model you can use. And also, there is also for speech to text, there is already a model for... intended NVIDIA, so we can use that...

🤖 AI Response 10: Specific NVIDIA Models

Action: Consolidated four model recommendations.

Parakeet: Speech-to-Text.

Nemotron Nano: Claim detection (fast/cheap).

Nemotron Super: Research/Debate agents (good tool calling).

Nemotron Ultra: Final Judge (best reasoning).

🗣️ User Query 11: Deep Technical Validation

Before they start, I want you to think everything for the front end and the back end, especially in the back end how the execution will work. Think about that deeply and everything. I mean, go from each step. Think about every step how it would be work use new and best technology

🤖 AI Response 11: Edge Cases & Modern Stack

Action: Added backend system with modern technology stack

Frontend Websockets: Held in the background service worker (Chrome 116+ keeps worker alive via active websockets).

Audio Chunking: Use Voice Activity Detection (VAD) instead of fixed time intervals to prevent cutting sentences in half.

Database: sqlite-vec chosen for semantic caching (vector similarity search inside a single SQLite file) so slightly rephrased claims hit the cache.

🗣️ User Query 12 - 16: Documentation Generation

(User requested detailed AI-friendly PRD, PROMPT, and BRAND GUIDE files. Iterated on making them explicitly detailed with reasoning, variables, and tech stacks. Concluded with preparing to hand files off to Claude Code Opus 4.8).