# Step-by-Step Guide to Vibe Coding — FactCheck AI

Welcome! If you have never done **Vibe Coding** before, this is the perfect place to start. 

**Vibe Coding** means you act as the **Product Manager and Director**, and the **AI Agent** (like Claude, Cursor, Windsurf, or Copilot) acts as the **Software Engineer**. You don't write the lines of code yourself. Instead, you guide the AI step-by-step, run its code, test it, tell the AI what worked or what broke, and help it refine the app until it is fully functional.

This guide will show you exactly how to code this project with your AI agent, **one simple step at a time**.

---

## 1. Prerequisites (Setup on your Laptop)

Before starting the AI, make sure you have these basic tools ready on your computer:
1. **VS Code** (or your favorite code editor).
2. **Python 3.11 or higher** installed.
3. **Google Chrome** browser installed.
4. **An NVIDIA API Key**: Get a free key from [build.nvidia.com](https://build.nvidia.com/) (this lets us use the AI models for free).
5. **A Tavily API Key** (optional, for web search tool) or you can tell the AI to use the free **DuckDuckGo** search wrapper.

---

## 2. The Golden Rules of Vibe Coding

To get the best results from your AI agent, follow these rules religiously:
* ⚠️ **One Phase at a Time**: Never ask the AI to build the whole project at once. It will get confused, make mistakes, or write incomplete placeholders.
* 🔍 **Always Verify Before Moving On**: Make sure the current phase is 100% working and tested before you let the AI start the next phase. **If you skip verification, the AI will build on top of broken code, and the whole project will collapse.**
* 📋 **Feed Context First**: When starting a new session, always tell the AI to read `PRD.md` and `PROMPT.md`.
* 🛠️ **No Silent Placeholders**: If the AI writes a comment like `// TODO: Implement later`, tell it: *"Do not use placeholders, write the complete implementation now."*
* 💥 **Report Errors Exactly**: If you get a terminal error or console crash, copy-paste the entire error log into the chat and say: *"I got this error, please fix it."*

### 🆘 STUCK? DO THIS!
If the AI is going in circles, giving you the same error over and over, or if it accidentally deleted old code:
1. **Tell it to stop guessing**: *"Stop. Please re-read the PRD.md to see how this is supposed to work."*
2. **Start a Fresh Chat**: AI agents have a "context limit". If the chat gets too long, it forgets things. Open a **New Chat**, ask it to read the `.md` files again, and say: *"Here is my current code for `[filename]`, we are on Phase X, but it has this error: [error]. Please fix it."*

---

## 3. Step-by-Step Build Walkthrough

Here is the exact sequence to build the project. Open your code editor in the `FactCheck_AI` folder and start chatting with your AI agent!

---

### Step 0: Initialize the Workspace

Start by giving the AI the project structure.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder (especially `PRD.md` and `PROMPT.md`) to understand the project. First, create the exact file and folder structure defined in Section 8 of the PRD. Create empty files for now so we have the skeleton."
* **What the AI should do:** Create the folders (`extension/background`, `extension/content`, `backend/agents`, etc.) and the empty files.

---

### Step 1: Build the Extension Skeleton (Phase 1)

Get the browser extension talking to Chrome.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 1 (Extension skeleton). Implement the `extension/manifest.json` and a basic `extension/background/service-worker.js` that attempts to open a WebSocket connection to `ws://localhost:8000/ws` and sends a keepalive message every 20 seconds. Make sure it auto-reconnects if disconnected."
* **How to Verify:**
  1. Open Google Chrome and go to `chrome://extensions`.
  2. Turn on **Developer mode** (top-right toggle).
  3. Click **Load unpacked** (top-left button) and select the `extension` folder.
  4. Look at the loaded extension card. Click on **service worker** (blue link under "Inspect views") to open the developer console.
  5. You should see connection attempts failing (since our backend is not running yet). This is correct!

---

### Step 2: Build the Backend WebSocket Server (Phase 2)

Get the FastAPI backend running.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Now let's build Phase 2 (Backend skeleton). Create `backend/requirements.txt` with FastAPI and Uvicorn. Create `backend/main.py` with a simple WebSocket endpoint at `/ws` that accepts connections and echoes back any JSON message it receives."
* **How to Verify:**
  1. **Open a Terminal**: In VS Code, go to the top menu and click **Terminal > New Terminal**.
  2. Navigate to the backend, set up a "Virtual Environment" (a safe space for Python packages), and install requirements. Run these commands one by one:
     ```powershell
     cd backend
     python -m venv .venv
     .venv\Scripts\activate
     pip install -r requirements.txt
     ```
     *(Note: If `.venv\Scripts\activate` fails on Windows, run `Set-ExecutionPolicy Unrestricted -Scope CurrentUser` first, then try again).*
  3. Run the server:
     ```powershell
     uvicorn main:app --reload --port 8000
     ```
  3. Go back to the Chrome extension's **service worker console** from Step 1.
  4. The extension should now connect successfully! You should see logs indicating the WebSocket is connected, and in your backend terminal, you should see keepalive messages arriving every 20 seconds.

---

### Step 3: Implement Caption Reading & Audio Capture (Phase 3)

Make the extension listen to videos.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 3. Update the content script `extension/content/content-script.js` to look for video elements. If captions are available (like on YouTube), stream them to the WebSocket. If no captions are available, set up the audio capture fallback via the offscreen document and use Voice Activity Detection (VAD) to slice the audio into natural phrases."
* **How to Verify:**
  1. In Chrome, go to `chrome://extensions` and click the **Reload icon** (circular arrow) on your FactCheck AI extension.
  2. Open a YouTube video that has English captions (like a news channel or talk show).
  3. Inspect the backend terminal. You should see `caption_chunk` JSON messages arriving with the text of the captions in real-time as the video plays.
  4. Now open a video/audio source with NO captions. Click the extension popup icon in your toolbar, go to Settings, and check "Listen to this tab's audio". You should see VAD-segmented audio chunks being generated.

---

### Step 4: Add Speech-to-Text (Phase 4)

Convert audio fallback chunks into readable text.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 4. Set up the environment loading in `backend/config.py` and implement the Parakeet model call in `backend/stt.py` using the NVIDIA NIM API. When the backend receives an `audio_chunk` message, it should send it to Parakeet and add the transcribed text to the session's rolling transcript buffer."
* **How to Verify:**
  1. Create a `backend/.env` file and add your `NVIDIA_API_KEY`.
  2. Reload the backend server.
  3. Play an audio/video stream with no captions, enable audio listening, and check the backend terminal logs. You should see the base64 audio chunks being converted into printed text phrases.

---

### Step 5: Implement Claim Detection (Phase 5)

Filter the transcript stream to identify checkable claims.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 5. Implement the rolling transcript buffer logic and the batched call to the Nemotron Nano model in `backend/claim_detection.py` using Pydantic AI. It should check the last 20 seconds of transcript, and return a clean list of factual claims found in that window in a single model call."
* **How to Verify:**
  1. Play a video. Keep an eye on the backend logs.
  2. When the speaker says opinion statements (e.g., *"This is a beautiful day!"*), nothing should be detected.
  3. When the speaker says a checkable claim (e.g., *"Inflation has risen by 10% this year"*), you should see a log: `Claim detected: "Inflation has risen by 10% this year"`.

---

### Step 6: Build the Semantic Cache (Phase 6)

Save time and rate limits by caching results.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 6. Set up SQLite with the `sqlite-vec` extension in `backend/cache.py`. When a claim is detected, generate its embedding using the NVIDIA embedding model and search the cache. If there's a match (similarity > 0.85), return the cached verdict immediately. Otherwise, save the new verdict to the cache when it completes."
* **How to Verify:**
  1. Play a video that generates a claim. Let the backend process it.
  2. Play the exact same video portion again.
  3. Check the logs: the second time, it should say `Cache Hit! Returning cached verdict for: [claim text]`. No API calls should be made to the research pipeline.

---

### Step 7: Build the Research, Debate, and Judge Pipeline (Phase 7)

This is the brain of the app where agents research, debate, and judge claims.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 7. Set up the queue manager with `asyncio.Queue` in `backend/queue_manager.py` with 2 workers. Create the three parallel research agents (General News, Official Data, Fact Checking Sites) using Nemotron Super in `backend/agents/research_agent.py`. Add the debate round in `backend/agents/debate.py` and the final Nemotron Ultra Judge call in `backend/agents/judge.py`. Send state updates (`checking`, `researching`, `debating`, `done`) to the extension."
* **How to Verify:**
  1. Play a video. Look at the backend terminal.
  2. Watch the logs flow step-by-step:
     - `Status: checking` (checking semantic cache)
     - `Status: researching` (agents performing web searches in parallel)
     - `Status: debating` (agents reading each other's drafts and revising)
     - `Status: done` (Judge compiling final verdict, verdict sent to extension)

---

### Step 8: Build and Polish the UI Overlay (Phase 8)

Make the claims appear on the web page.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 8. Implement the Shadow DOM rendering in `extension/content/content-script.js` and styles in `extension/content/overlay.css`. Make sure that when claim updates arrive, cards change color and state smoothly (`Checking...` -> `Researching...` -> `Debating...` -> colored verdict card). Ensure clicking 'View Details' shows the explanation and sources, and settings toggle the overlay on/off."
  *(Note: If you have a `BRAND_GUIDE.md` file, tell the AI to read it before writing the CSS!)*
* **How to Verify:**
  1. Reload the Chrome extension.
  2. Open YouTube. You should see a small overlay panel appear on the right side of your screen.
  3. Play a political speech or news video.
  4. Watch the overlay: a card should pop up saying `Checking...`, then transition through the states, and finally show a colored verdict badge (e.g. `Contradicted` in red or `Supported` in green).
  5. Click on the card to see the bullet-point sources and explanation.

---

### Step 9: Final Resilience & Error Handling Pass (Phase 9)

Make the app bulletproof.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Let's build Phase 9. Ensure the error handling rules from Section 12.8 of the PRD are met: if one research agent fails, the judge still produces a verdict with reduced confidence; if all three fail, resolve to 'unverifiable'; if the WebSocket drops, hold queued claims and reconnect gracefully without crashing."
* **How to Verify:**
  1. Temporarily disconnect your internet connection or simulate a search failure in one agent.
  2. The system should still output a verdict successfully.
  3. Restart the backend while the extension is running. The extension should reconnect automatically.

---

### Step 10: Final Cross-Check and Security Review

Make sure the project meets all requirements and that your secrets are secure.

* **Your Prompt to the AI:**
  > "Please refer to all .md files present in the folder. Review the entire codebase we have built for FactCheck AI. Cross-check all components, files, WebSocket messages, and state transitions against the specifications in `PRD.md` and `PROMPT.md`. Double-check the following items and fix any issues:
  > 1. Secrets & Security: Verify that NO API keys, client secrets, or private tokens are hardcoded in the codebase or pushed to GitHub. All secrets must be loaded via `.env`.
  > 2. Env Example: Make sure you create a `backend/.env.example` file that shows which environment variables are needed.
  > 3. Git Rules: Verify that there is a `.gitignore` file in the project root, and check that it contains `.env` and `*.db` so they are never pushed.
  > 4. Implementation Check: Confirm that everything was made exactly as decided in the PRD, with no missing pieces.
  > Print a status report of what was verified and any corrections made."
* **How to Verify:**
  1. Check your project folder to ensure `backend/.env.example` exists.
  2. Open `.gitignore` and ensure `.env` and `*.db` are listed.
  3. Ensure the AI provides a clean status report.

---

## 4. Handing Over to Your Friend for Debugging

Once you have followed these steps, you will have a fully built application!

If something behaves strangely, or if the layout looks slightly off, **do not worry**. Your friend will do a final debugging run. To help them:
1. Keep the `backend/factcheck.db` file (this contains the cache of claims you tested).
2. Save any error logs from the Chrome developer console (Right-click page → **Inspect** → **Console**) or the service worker console.
3. Save any error traces from your backend terminal.

Have fun Vibe Coding! 🚀
