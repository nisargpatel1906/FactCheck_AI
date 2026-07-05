console.log("[Offscreen] Offscreen script initialized.");

// Signal to background worker that the offscreen document is loaded and ready
chrome.runtime.sendMessage({ type: "offscreen-ready" }).catch(() => {});

let mediaStream = null;
let outputAudio = null;
let activeRecorder = null;
let recordIntervalId = null;

const MAX_CHUNK_DURATION_MS = 60000; // 60 seconds chunking

let isPaused = false;

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener(async (message) => {
  console.log("[Offscreen] Received message:", message.type);
  if (message.type === "start-capture") {
    try {
      await stopCapture();
      await startCapture(message.streamId);
    } catch (error) {
      console.error("[Offscreen] Failed to start capture:", error);
    }
  } else if (message.type === "stop-capture") {
    await stopCapture();
  } else if (message.type === "pause-capture") {
    isPaused = true;
    if (outputAudio) outputAudio.pause();
    console.log("[Offscreen] Audio capture paused.");
  } else if (message.type === "resume-capture") {
    isPaused = false;
    if (outputAudio) outputAudio.play().catch(() => {});
    console.log("[Offscreen] Audio capture resumed.");
  }
});

async function startCapture(streamId) {
  console.log("[Offscreen] Starting tab audio capture, streamId:", streamId);

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId }
    },
    video: false
  });

  // Pass-through so the user still hears the tab
  outputAudio = new Audio();
  outputAudio.srcObject = mediaStream;
  outputAudio.play();

  startRecordingCycle();
  console.log("[Offscreen] Audio capture started (MediaRecorder, 15s chunks).");
}

function startRecordingCycle() {
  if (!mediaStream) return;
  
  activeRecorder = new MediaRecorder(mediaStream, { mimeType: "audio/webm;codecs=opus" });
  
  activeRecorder.ondataavailable = async (event) => {
    if (isPaused) return; // ignore chunk if paused
    if (event.data.size > 0) {
      console.log(`[Offscreen] Chunk captured. Size: ${event.data.size} bytes`);
      const buffer = await event.data.arrayBuffer();
      const base64Audio = arrayBufferToBase64(buffer);
      
      chrome.runtime.sendMessage({
        type: "audio_chunk",
        audio_base64: base64Audio,
        format: "webm",
        timestamp_ms: Date.now()
      }).catch(err => console.error("[Offscreen] Failed to send audio chunk:", err));
    }
  };

  activeRecorder.start();
  
  // Send progress every second
  let elapsed = 0;
  recordIntervalId = setInterval(() => {
    if (isPaused) return;
    elapsed += 1000;
    chrome.runtime.sendMessage({
      type: "audio_progress",
      durationMs: elapsed,
      maxMs: MAX_CHUNK_DURATION_MS
    }).catch(() => {});
    
    if (elapsed >= MAX_CHUNK_DURATION_MS) {
      // Time to cycle the recorder
      cycleRecorder();
    }
  }, 1000);
}

function cycleRecorder() {
  if (recordIntervalId) {
    clearInterval(recordIntervalId);
    recordIntervalId = null;
  }
  if (activeRecorder && activeRecorder.state === "recording") {
    activeRecorder.stop(); // This triggers ondataavailable
  }
  startRecordingCycle();
}

async function stopCapture() {
  console.log("[Offscreen] Stopping capture...");

  if (recordIntervalId) {
    clearInterval(recordIntervalId);
    recordIntervalId = null;
  }

  if (outputAudio) {
    outputAudio.pause();
    outputAudio.srcObject = null;
    outputAudio = null;
  }

  if (activeRecorder && activeRecorder.state === "recording") {
    activeRecorder.stop();
    activeRecorder = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  chrome.runtime.sendMessage({ type: "audio_progress", durationMs: 0, maxMs: MAX_CHUNK_DURATION_MS }).catch(() => {});
  console.log("[Offscreen] Audio capture stopped.");
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
