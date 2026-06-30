# 🛡️ FactCheck AI

FactCheck AI is a real-time, browser-based fact-checking pipeline designed to actively monitor live video and audio streams (like YouTube or news broadcasts) and autonomously verify factual claims as they are spoken. 

Powered by a local asynchronous Python backend, **NVIDIA NIM** models, and a multi-agent debate architecture, FactCheck AI surfaces verified truth directly in your browser without interrupting your viewing experience.

---

## ✨ Features

- **Real-Time Claim Detection**: Silently monitors closed captions or live tab audio to identify testable factual claims.
- **Multi-Agent Research Pipeline**: Dispatches 3 parallel AI research agents to investigate the claim from different angles (general news, official data, and fact-checking sites).
- **Collaborative Debate**: Agents debate their initial findings, updating their stances based on cross-referenced evidence.
- **Final Judge Verdict**: A powerful judge model synthesizes the debate to issue a final verdict (`SUPPORTED`, `CONTRADICTED`, `MIXED`, `UNVERIFIABLE`).
- **Semantic Caching**: Utilizes `sqlite-vec` to instantly recall verdicts for previously checked claims via vector embeddings, saving API calls and time.
- **Sleek Browser Overlay**: A modern, non-intrusive sidebar directly injected into the webpage via Shadow DOM, displaying live fact-checking feeds and sources.

---

## 🏗️ Architecture

FactCheck AI consists of two primary layers:

### 1. Browser Extension (Frontend)
Built using plain HTML, CSS, and Vanilla JavaScript (Manifest V3). 
* **Content Script**: Injects the UI overlay using Shadow DOM to prevent style conflicts with the host page. Captures YouTube captions automatically.
* **Offscreen Document**: Serves as a fallback for capturing raw tab audio when closed captions are unavailable, chunking it via Voice Activity Detection (VAD).
* **Service Worker**: Maintains a persistent WebSocket connection to the Python backend to stream captions/audio and receive live status updates and verdicts.

### 2. Python Backend (Server)
Built with **FastAPI** and **Pydantic AI**, orchestrated via `asyncio`.
* **WebSocket Server**: Ingests transcription chunks and streams real-time state changes to the UI.
* **Speech-To-Text (STT)**: (Optional) Transcribes raw audio chunks if captions are not provided.
* **Agent Flow**:
  1. **Claim Detection** (`Nemotron Nano`): Fast, cheap filtering to determine if a sentence is a factual claim.
  2. **Parallel Research** (`Nemotron Super`): Tool-calling agents use Tavily/DuckDuckGo to gather evidence.
  3. **Collaborative Debate** (`Nemotron Super`): Agents review each other's research and refine their stances.
  4. **The Judge** (`Nemotron Ultra`): Evaluates the final debate and produces a concrete verdict with sources.

---

## 🚀 Getting Started

### Prerequisites
* **Python 3.11+**
* **Google Chrome** (Version 116+)
* **NVIDIA API Key** (from [build.nvidia.com](https://build.nvidia.com))
* **Tavily API Key** (Optional, for enhanced web search capabilities)

### 1. Setup the Backend Server
1. Navigate to the `backend/` directory.
2. Create a virtual environment and install dependencies:
   ```bash
   python -m venv .venv
   source .venv/bin/activate  # On Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. Configure your environment variables:
   Copy `.env.example` to `.env` inside the `backend/` directory and populate it:
   ```env
   NVIDIA_API_KEY=your_nvidia_api_key_here
   TAVILY_API_KEY=your_tavily_api_key_here
   ```
4. Start the server:
   ```bash
   uvicorn main:app --host 127.0.0.1 --port 8000
   # Alternatively, run the start.bat script on Windows.
   ```

### 2. Install the Browser Extension
1. Open Google Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top right corner).
3. Click **Load unpacked** and select the `extension/` folder from this repository.
4. Pin the **FactCheck AI** icon to your browser toolbar.

### 3. Usage
1. Open any YouTube video (e.g., a news broadcast or political speech).
2. Click the **FactCheck AI** extension icon in your toolbar.
3. The sidebar will slide open. As the speaker talks, claims will automatically populate the sidebar, transitioning from `Checking` to their final colored verdict along with cited sources!

---

## 🛠️ Technology Stack
* **Language Models**: NVIDIA Inference Microservices (NIM)
  * Meta Llama 3.1 8B (Claim Detection)
  * Nemotron Super/Ultra (Research & Judging)
  * NV-EmbedQA (Semantic Search)
* **Backend**: Python, FastAPI, Pydantic AI, SQLite (`sqlite-vec`)
* **Frontend**: HTML5, CSS3, Vanilla JavaScript, Chrome Extension API (Manifest V3)

---

## 📝 License
This project is licensed under the **GNU General Public License v3.0 (GPL-3.0)**. See the [LICENSE](LICENSE) file for more details.

---

## 👨‍💻 Developers
This project is proudly developed by:
* **Nisarg Patel** - [GitHub Profile](https://github.com/nisargpatel1906)
* **Kathan Shah** - [GitHub Profile](https://github.com/kathan472)
