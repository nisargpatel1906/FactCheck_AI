let socket = null;
let keepaliveInterval = null;
let isConnected = false;
let hasCreatedOffscreen = false;
let isCapturing = false;  // fix: was used but never declared
const messageQueue = [];

// Session history cache to restore side panel on open
let sessionClaims = [];
let sessionTranscript = "";

// Reconnect backoff: 1s → 2s → 4s … capped at 30s
let reconnectDelay = 1000;

// Listen for action click to toggle the overlay on the active tab
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
    });
  } catch (error) {
    console.error("[Service Worker] Error setting up capture:", error);
  }
}

function connect() {
  console.log("[Service Worker] Attempting to connect to WebSocket...");
  socket = new WebSocket("ws://localhost:8000/ws");

  socket.onopen = () => {
    console.log("[Service Worker] WebSocket connected successfully.");
    reconnectDelay = 1000; // reset backoff on successful connection
    setIsConnected(true);
    
    // Flush queued messages if any exist
    if (messageQueue.length > 0) {
      console.log(`[Service Worker] Reconnected. Flushing ${messageQueue.length} queued messages...`);
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift();
        try {
          socket.send(JSON.stringify(msg));
        } catch (e) {
          console.error("[Service Worker] Error sending queued message, putting back in queue:", e);
          messageQueue.unshift(msg);
          break;
        }
      }
    }
    
    // Clear any existing interval to prevent duplicates
    if (keepaliveInterval) {
      clearInterval(keepaliveInterval);
    }
    
    // Start keepalive interval
    keepaliveInterval = setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        console.log("[Service Worker] Sending keepalive...");
        sendToWebSocket({ type: "keepalive" });
      }
    }, 20000);
  };

  socket.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log("[Service Worker] Received message from backend:", message);
      
      // Cache session history
      if (message.type === "transcription") {
        sessionTranscript = (sessionTranscript + " " + message.text).trim().slice(-500);
      } else if (message.type === "status_update") {
        const existing = sessionClaims.find(c => c.claim_id === message.claim_id);
        if (existing) {
          existing.status = message.status;
        } else {
          sessionClaims.push(message);
        }
      } else if (message.type === "verdict_update") {
        const index = sessionClaims.findIndex(c => c.claim_id === message.claim_id);
        if (index !== -1) {
          sessionClaims[index] = { ...sessionClaims[index], ...message };
        } else {
          sessionClaims.push(message);
        }
      }

      // Relay message to popup/side panel if they are active
      chrome.runtime.sendMessage(message).catch(() => {});
      
      // Relay message to all active tabs (e.g. content script overlay)
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach((tab) => {
          if (tab.id) {
            chrome.tabs.sendMessage(tab.id, message).catch(() => {});
          }
        });
      });
    } catch (error) {
      console.error("[Service Worker] Error parsing message:", error);
    }
  };

  socket.onclose = (event) => {
    console.log(`[Service Worker] WebSocket closed. Reason: ${event.reason}. Reconnecting in ${reconnectDelay}ms...`);
    setIsConnected(false);
    cleanup();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
  };

  socket.onerror = (error) => {
    console.error("[Service Worker] WebSocket error:", error);
  };
}

function setIsConnected(val) {
  isConnected = val;
  // Notify popup if it is open
  chrome.runtime.sendMessage({
    type: "connection-status-update",
    connected: isConnected
  }).catch(() => {});
}

function cleanup() {
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    keepaliveInterval = null;
  }
}

function sendToWebSocket(msg) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    // Queue payload messages, ignore keepalive
    if (msg.type !== "keepalive") {
      console.warn(`[Service Worker] WebSocket not open. Buffering message to queue: ${msg.type}`);
      messageQueue.push(msg);
    }
  }
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

// fix: stopCapture was called but never defined
function stopCapture() {
  isCapturing = false;
  sessionClaims = [];
  sessionTranscript = "";
  chrome.storage.local.set({ audioCaptureEnabled: false });
  chrome.runtime.sendMessage({ type: "stop-capture" }).catch(() => {});
  closeOffscreen().catch(() => {});
}

let pendingStreamId = null;

// Track connection from the side panel to determine if it is open
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "sidepanel") {
    isSidePanelOpen = true;
    console.log("[Service Worker] Side panel port connected.");
    
    // Immediately push current connection status
    port.postMessage({ type: "connection-status-update", connected: isConnected });
    
    // Restore session transcript and claims to newly opened Side Panel port context
    if (sessionTranscript) {
      port.postMessage({ type: "restore-transcript", text: sessionTranscript });
    }
    if (sessionClaims.length > 0) {
      port.postMessage({ type: "restore-claims", claims: sessionClaims });
    }

    port.onDisconnect.addListener(() => {
      isSidePanelOpen = false;
      console.log("[Service Worker] Side panel port disconnected.");
    });
  }
});

// Receive messages from content script, offscreen, and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Service Worker] Message received:", message.type);

  if (message.type === "caption_chunk") {
    // Forward captions directly to WebSocket
    sendToWebSocket({
      type: "caption_chunk",
      session_id: "session_local",
      text: message.text,
      timestamp_ms: message.timestamp_ms
    });
  } 
  
  else if (message.type === "manual_claim") {
    // Forward manual selection claims directly to WebSocket
    sendToWebSocket({
      type: "manual_claim",
      session_id: "session_local",
      text: message.text,
      timestamp_ms: message.timestamp_ms
    });
  }
  
  else if (message.type === "audio_chunk") {
    // Forward audio chunk base64 directly to WebSocket
    sendToWebSocket({
      type: "audio_chunk",
      session_id: "session_local",
      audio_base64: message.audio_base64,
      format: message.format,
      timestamp_ms: message.timestamp_ms
    });
  } 

  else if (message.type === "audio_progress") {
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id) {
          chrome.tabs.sendMessage(tab.id, message).catch(() => {});
        }
      });
    });
  }

  else if (message.type === "offscreen-ready") {
    console.log("[Service Worker] Offscreen ready received. Pending stream ID:", pendingStreamId);
    // Retry briefly in case pendingStreamId is set just after the ready signal fires
    // (race: offscreen signals ready before setupOffscreen() caller assigns pendingStreamId)
    const waitForStreamId = (attempts) => {
      if (pendingStreamId) {
        const id = pendingStreamId;
        pendingStreamId = null;
        chrome.runtime.sendMessage({ type: "start-capture", streamId: id })
          .catch((err) => console.error("[Service Worker] Error sending start-capture:", err));
      } else if (attempts > 0) {
        setTimeout(() => waitForStreamId(attempts - 1), 50);
      } else {
        console.warn("[Service Worker] offscreen-ready received but no pendingStreamId after retries.");
      }
    };
    waitForStreamId(10); // up to 500ms of retries
  }
  
  else if (message.type === "toggle-audio-capture") {
    if (!message.enabled) {
      stopCapture();
    }
    // If enabled from UI, it will start next time the overlay is opened via extension icon
  }
  
  else if (message.type === "pause-audio-capture") {
    chrome.runtime.sendMessage({ type: "pause-capture" }).catch(() => {});
  }
  
  else if (message.type === "resume-audio-capture") {
    chrome.runtime.sendMessage({ type: "resume-capture" }).catch(() => {});
  }
  
  else if (message.type === "get-connection-status") {
    sendResponse({ connected: isConnected });
  }

  return true; // Keep message channel open for async response
});

connect();
