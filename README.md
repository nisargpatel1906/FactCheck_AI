# FactCheck AI

A Chrome (MV3) extension + Python backend that listens to the video in the
active tab, detects spoken factual claims, researches them with a team of AI
agents on NVIDIA NIM, and shows verdicts (Supported / Contradicted / Mixed /
Unverifiable) in an on-page overlay.

See [PRD.md](PRD.md) for the full spec and [PROMPT.md](PROMPT.md) for the build
order. This README covers running what's built.

## Build status

| Phase | Area | Status |
|---|---|---|
| 1 | Extension skeleton (SW + WebSocket + keepalive) | ✅ |
| 2 | Backend FastAPI WebSocket | ✅ |
| 3 | Caption detection + audio-capture (VAD) fallback | ✅ |
| 4 | Speech-to-text (Parakeet) | ✅ |
| 5 | Batched claim detection (Nemotron Nano) | ✅ |
| 6 | Semantic cache (SQLite + sqlite-vec) | ✅ |
| 7 | Research → debate → judge pipeline | ✅ |
| 8 | **Brand-exact UI styling** | ⏳ **pending `BRAND_GUIDE.md`** |
| 9 | Error-handling pass | ✅ (resilience wired throughout) |

> **Styling is placeholder.** `BRAND_GUIDE.md` was not in the project at build
> time. Every color/font/spacing value in `extension/content/overlay.css` and
> `extension/popup/popup.css` is a neutral placeholder marked `TODO`. Drop
> `BRAND_GUIDE.md` in and Phase 8 will replace these with its tokens — no
> invented brand values are kept (per the PROMPT rules).

## Backend

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt
cp .env.example .env          # then edit .env and set NVIDIA_API_KEY
uvicorn main:app --reload --port 8000
```

The server exposes `GET /` (health) and `ws://localhost:8000/ws`.

Minimum to run: set `NVIDIA_API_KEY`. For videos **without** captions you also
need `STT_FUNCTION_ID` (the Parakeet model's function-id from its
build.nvidia.com model card). Captioned videos (most of YouTube) need neither.

## Extension

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select the `extension/` folder.
3. Start the backend (above), then open a video. Captioned videos are read
   automatically. For audio-only sites, click the extension icon → **Settings**
   → **Listen to this tab's audio** (Chrome requires this click to allow tab
   capture).

## Notes & caveats

- **Model ids** are confirmed against build.nvidia.com but the catalog changes —
  all are overridable via env (see `.env.example`). The **judge** defaults to the
  Super model; the PRD specifies **Ultra** — set `NVIDIA_JUDGE_MODEL` to the
  verified Ultra id to match the spec exactly.
- **sqlite-vec on Windows**: requires a Python whose `sqlite3` allows loadable
  extensions (python.org 3.11+ builds generally do). If it can't load, the cache
  disables itself and the app still runs (every claim goes through the pipeline).
- **Rate limit**: a small worker pool + a shared concurrency limiter + a token
  bucket keep usage under NVIDIA's ~40 rpm free tier; the cache is what makes
  repeated claims effectively free (PRD 12.1/12.6).
