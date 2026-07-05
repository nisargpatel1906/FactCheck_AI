let hasCreatedOffscreen = false;
let isCapturing = false;
let isSidePanelOpen = false;

// Session history cache
let sessionClaims = [];
let sessionTranscript = "";

// Default backend HTTP URL
const DEFAULT_BACKEND_URL = "https://backend-tawny-six-95.vercel.app";

// Polling interval for claim detection (in milliseconds)
const CLAIM_DETECTION_INTERVAL = 10000; // 10 seconds
let detectionIntervalId = null;

// Track active pipeline tasks to avoid duplicate execution
const activeClaims = new Set();

chrome.action.onClicked.addListener((tab) => {
  if (tab.id) {
    chrome.tabs.sendMessage(tab.id, { type: "toggle-overlay" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response && response.visible) {
        chrome.storage.local.get(["audioCaptureEnabled"], (result) => {
          if (result.audioCaptureEnabled) {
            startAudioCapture(tab);
          }
        });
      } else {
        stopCapture();
      }
    });
  }
});

function startAudioCapture(activeTab) {
  if (isCapturing) return;
  try {
    chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, async (streamId) => {
      if (chrome.runtime.lastError) {
        console.error("[Service Worker] Tab capture error:", chrome.runtime.lastError);
        return;
      }
      console.log("[Service Worker] Got media stream ID. Creating offscreen...");
      pendingStreamId = streamId;
      isCapturing = true;
      await setupOffscreen();
      startClaimDetectionLoop();
    });
  } catch (error) {
    console.error("[Service Worker] Error setting up capture:", error);
  }
}

async function getBackendUrl() {
  const result = await chrome.storage.local.get(["backendUrl"]);
  let url = (result.backendUrl || DEFAULT_BACKEND_URL).trim();
  // Ensure it's an HTTP URL, not WS
  if (url.startsWith("ws://")) url = url.replace("ws://", "http://");
  if (url.startsWith("wss://")) url = url.replace("wss://", "https://");
  if (url.endsWith("/")) url = url.slice(0, -1);
  return url;
}

// ── Vercel REST Pipeline Orchestration ──────────────────────────────────────

async function processAudioChunk(audio_base64) {
  const baseUrl = await getBackendUrl();
  try {
    const res = await fetch(`${baseUrl}/api/stt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_base64 })
    });
    if (!res.ok) throw new Error(`STT HTTP ${res.status}`);
    const data = await res.json();
    
    if (data.text) {
      console.log("[Service Worker] Transcribed:", data.text);
      sessionTranscript = (sessionTranscript + " " + data.text).trim().slice(-1000);
      
      broadcastMessage({
        type: "transcription",
        text: data.text
      });
    }
  } catch (error) {
    console.error("[Service Worker] STT request failed:", error);
  }
}

function startClaimDetectionLoop() {
  if (detectionIntervalId) clearInterval(detectionIntervalId);
  detectionIntervalId = setInterval(async () => {
    if (!sessionTranscript.trim()) return;
    
    const baseUrl = await getBackendUrl();
    try {
      const res = await fetch(`${baseUrl}/api/detect_claims`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript_window: sessionTranscript })
      });
      if (!res.ok) throw new Error(`Detect HTTP ${res.status}`);
      const data = await res.json();
      
      for (const claim of (data.claims || [])) {
        if (!activeClaims.has(claim)) {
          executeFactCheckPipeline(claim, baseUrl);
        }
      }
    } catch (error) {
      console.error("[Service Worker] Claim detection failed:", error);
    }
  }, CLAIM_DETECTION_INTERVAL);
}

async function executeFactCheckPipeline(claimText, baseUrl) {
  if (activeClaims.has(claimText)) return;
  activeClaims.add(claimText);
  
  const claim_id = "claim_" + Math.random().toString(36).substr(2, 9);
  
  console.log(`[Pipeline] Starting for: "${claimText}"`);
  
  // 1. Cache Lookup
  broadcastMessage({ type: "status_update", claim_id, claim_text: claimText, status: "checking" });
  
  try {
    const cacheRes = await fetch(`${baseUrl}/api/cache_lookup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_text: claimText })
    });
    const cacheData = await cacheRes.json();
    
    if (cacheData.cached) {
      console.log(`[Pipeline] Cache hit for: "${claimText}"`);
      broadcastVerdict({
        claim_id, claim_text: claimText,
        verdict: cacheData.verdict,
        explanation: cacheData.explanation,
        sources: cacheData.sources,
        cached: true
      });
      return;
    }
    
    // 2. Research (Parallel)
    broadcastMessage({ type: "status_update", claim_id, claim_text: claimText, status: "researching" });
    const angles = ["general_news", "official_data", "fact_check_sites"];
    const drafts = {};
    
    await Promise.all(angles.map(async (angle) => {
      try {
        const res = await fetch(`${baseUrl}/api/research`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim_text: claimText, angle })
        });
        drafts[angle] = await res.json();
      } catch (err) {
        console.error(`[Pipeline] Research failed for ${angle}:`, err);
        drafts[angle] = { stance: "missing_evidence", confidence: 0, evidence_summary: "Error", sources: [] };
      }
    }));
    
    // 3. Debate (Parallel)
    broadcastMessage({ type: "status_update", claim_id, claim_text: claimText, status: "debating" });
    const revisedDrafts = {};
    
    await Promise.all(angles.map(async (angle) => {
      const otherDrafts = { ...drafts };
      delete otherDrafts[angle];
      
      try {
        const res = await fetch(`${baseUrl}/api/debate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            claim_text: claimText,
            angle: angle,
            self_draft: drafts[angle],
            other_drafts: otherDrafts
          })
        });
        revisedDrafts[angle] = await res.json();
      } catch (err) {
        console.error(`[Pipeline] Debate failed for ${angle}:`, err);
        revisedDrafts[angle] = drafts[angle]; // fallback
      }
    }));
    
    // 4. Judge
    const judgeRes = await fetch(`${baseUrl}/api/judge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_text: claimText, revised_drafts: revisedDrafts })
    });
    const verdictData = await judgeRes.json();
    
    // 5. Save to Cache
    await fetch(`${baseUrl}/api/cache`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claim_text: claimText, verdict_data: verdictData })
    }).catch(err => console.error("[Pipeline] Cache save failed:", err));
    
    console.log(`[Pipeline] Finished for: "${claimText}" - ${verdictData.verdict}`);
    broadcastVerdict({
      claim_id, claim_text: claimText,
      verdict: verdictData.verdict,
      explanation: verdictData.explanation,
      sources: verdictData.sources,
      cached: false
    });

  } catch (err) {
    console.error(`[Pipeline] Fatal error for "${claimText}":`, err);
    broadcastVerdict({
      claim_id, claim_text: claimText,
      verdict: "unverifiable",
      explanation: "A server error occurred during the fact-check process.",
      sources: [], cached: false
    });
  }
}

// ── Messaging & State ─────────────────────────────────────────────────────────

function broadcastMessage(message) {
  if (message.type === "status_update") {
    const existing = sessionClaims.find(c => c.claim_id === message.claim_id);
    if (existing) existing.status = message.status;
    else sessionClaims.push(message);
  }
  chrome.runtime.sendMessage(message).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach(t => {
      if (t.id) chrome.tabs.sendMessage(t.id, message).catch(() => {});
    });
  });
}

function broadcastVerdict(message) {
  message.type = "verdict_update";
  const index = sessionClaims.findIndex(c => c.claim_id === message.claim_id);
  if (index !== -1) sessionClaims[index] = { ...sessionClaims[index], ...message };
  else sessionClaims.push(message);
  
  broadcastMessage(message);
}

// Manage Offscreen Document Lifecycle
async function setupOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });

  if (existingContexts.length > 0) {
    hasCreatedOffscreen = true;
    return;
  }

  console.log("[Service Worker] Creating offscreen document...");
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for real-time transcription fallback"
  });
  hasCreatedOffscreen = true;
}

async function closeOffscreen() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"]
  });

  if (existingContexts.length > 0) {
    console.log("[Service Worker] Closing offscreen document...");
    await chrome.offscreen.closeDocument();
  }
  hasCreatedOffscreen = false;
}

function stopCapture() {
  isCapturing = false;
  if (detectionIntervalId) clearInterval(detectionIntervalId);
  sessionClaims = [];
  sessionTranscript = "";
  activeClaims.clear();
  chrome.storage.local.set({ audioCaptureEnabled: false });
  chrome.runtime.sendMessage({ type: "stop-capture" }).catch(() => {});
  closeOffscreen().catch(() => {});
}

let pendingStreamId = null;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    isSidePanelOpen = true;
    console.log("[Service Worker] Side panel port connected.");
    
    port.postMessage({ type: "connection-status-update", connected: true });
    
    if (sessionTranscript) port.postMessage({ type: "restore-transcript", text: sessionTranscript });
    if (sessionClaims.length > 0) port.postMessage({ type: "restore-claims", claims: sessionClaims });

    port.onDisconnect.addListener(() => {
      isSidePanelOpen = false;
      console.log("[Service Worker] Side panel port disconnected.");
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "caption_chunk") {
    sessionTranscript = (sessionTranscript + " " + message.text).trim().slice(-1000);
  } else if (message.type === "manual_claim") {
    // Manual claims always run — remove from dedup set first so re-checks work
    activeClaims.delete(message.text);
    getBackendUrl().then(url => executeFactCheckPipeline(message.text, url));
  } else if (message.type === "audio_chunk") {
    if (message.audio_base64) processAudioChunk(message.audio_base64);
  } else if (message.type === "audio_progress") {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      });
    });
  } else if (message.type === "offscreen-ready") {
    const waitForStreamId = (attempts) => {
      if (pendingStreamId) {
        const id = pendingStreamId;
        pendingStreamId = null;
        chrome.runtime.sendMessage({ type: "start-capture", streamId: id })
          .catch((err) => console.error("[Service Worker] Error sending start-capture:", err));
      } else if (attempts > 0) {
        setTimeout(() => waitForStreamId(attempts - 1), 50);
      }
    };
    waitForStreamId(10);
  } else if (message.type === "toggle-audio-capture") {
    if (!message.enabled) stopCapture();
  } else if (message.type === "pause-audio-capture") {
    chrome.runtime.sendMessage({ type: "pause-capture" }).catch(() => {});
  } else if (message.type === "resume-audio-capture") {
    chrome.runtime.sendMessage({ type: "resume-capture" }).catch(() => {});
  } else if (message.type === "get-connection-status") {
    sendResponse({ connected: true }); // REST API is inherently stateless/connected
  } else if (message.type === "reconnect-backend") {
    console.log("[Service Worker] Backend URL updated (REST mode).");
  }
  return true;
});
