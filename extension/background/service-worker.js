let socket = null;
let keepaliveInterval = null;
let isConnected = false;
let hasCreatedOffscreen = false;
const messageQueue = [];

// Reconnect backoff: 1s → 2s → 4s … capped at 30s
let reconnectDelay = 1000;

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

let pendingStreamId = null;

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
    if (pendingStreamId) {
      chrome.runtime.sendMessage({
        type: "start-capture",
        streamId: pendingStreamId
      }).then(() => {
        pendingStreamId = null;
      }).catch((err) => {
        console.error("[Service Worker] Error sending start-capture to offscreen:", err);
      });
    }
  }
  
  else if (message.type === "toggle-audio-capture") {
    if (message.enabled) {
      // Begin tab capture
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        const activeTab = tabs[0];
        if (!activeTab) return;

        try {
          chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id }, async (streamId) => {
            if (chrome.runtime.lastError) {
              console.error("[Service Worker] Tab capture error:", chrome.runtime.lastError);
              return;
            }
            
            console.log("[Service Worker] Got media stream ID. Creating offscreen...");
            pendingStreamId = streamId;
            await setupOffscreen();
          });
        } catch (error) {
          console.error("[Service Worker] Error setting up capture:", error);
        }
      });
    } else {
      // Stop capture and close offscreen
      chrome.runtime.sendMessage({ type: "stop-capture" }).catch(() => {});
      closeOffscreen().catch(() => {});
    }
  }
  
  else if (message.type === "get-connection-status") {
    sendResponse({ connected: isConnected });
  }

  return true; // Keep message channel open for async response
});


chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id) {
    if (!isCapturing) {
      // Synchronously call getMediaStreamId to preserve the user gesture context!
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (streamId) => {
        if (chrome.runtime.lastError) {
          console.error("[Service Worker] Tab capture error:", chrome.runtime.lastError);
          // Fallback toggle overlay even if capture fails
          chrome.tabs.sendMessage(tab.id, { type: "set-overlay-visible", visible: true }).catch(() => {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              files: ["content/content-script.js"]
            }).then(() => {
              setTimeout(() => {
                chrome.tabs.sendMessage(tab.id, { type: "set-overlay-visible", visible: true });
              }, 100);
            });
          });
          return;
        }

        console.log("[Service Worker] Synchronously obtained media stream ID on click. Creating offscreen...");
        pendingStreamId = streamId;
        setupOffscreen();
        isCapturing = true;
        chrome.storage.local.set({ audioCaptureEnabled: true, showOverlay: true });

        // Show on-page overlay
        chrome.tabs.sendMessage(tab.id, { type: "set-overlay-visible", visible: true }).catch(() => {
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["content/content-script.js"]
          }).then(() => {
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { type: "set-overlay-visible", visible: true });
            }, 100);
          });
        });
      });
    } else {
      stopCapture();
      chrome.tabs.sendMessage(tab.id, { type: "set-overlay-visible", visible: false }).catch(() => {});
    }
  }
});

connect();
