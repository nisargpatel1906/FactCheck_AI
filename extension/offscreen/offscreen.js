console.log("[Offscreen] Offscreen script initialized.");

// Signal to background worker that the offscreen document is loaded and ready
chrome.runtime.sendMessage({ type: "offscreen-ready" }).catch(() => {});

let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;
let outputAudio = null;

// VAD parameters
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const RMS_THRESHOLD = 0.015; // Volume threshold to trigger speaking
const SILENCE_TIMEOUT_MS = 5000; // 5 seconds of silence to split chunk
const MAX_CHUNK_DURATION_MS = 60000; // 60 seconds (1 minute) to provide more context

let audioBuffer = [];
let isSpeaking = false;
let silenceTimer = null;
let speechStartTimestamp = null;
let lastProgressMs = 0;

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener(async (message) => {
  console.log("[Offscreen] Received message:", message);
  if (message.type === "start-capture") {
    try {
      if (audioContext) {
        await stopCapture();
      }
      await startCapture(message.streamId);
    } catch (error) {
      console.error("[Offscreen] Failed to start capture:", error);
    }
  } else if (message.type === "stop-capture") {
    await stopCapture();
  }
});

async function startCapture(streamId) {
  console.log(`[Offscreen] Starting tab audio capture for stream ID: ${streamId}`);
  
  // Retrieve the tab capture stream
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  // Play the original stream back so the user can still hear it at full quality
  outputAudio = new Audio();
  outputAudio.srcObject = mediaStream;
  outputAudio.play();

  // Create AudioContext at 16kHz for efficient speech-to-text downsampling
  audioContext = new (window.AudioContext || window.webkitAudioContext)({
    sampleRate: SAMPLE_RATE
  });

  const source = audioContext.createMediaStreamSource(mediaStream);
  
  // ScriptProcessor node for custom volume analysis and buffer collection
  scriptProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
  
  source.connect(scriptProcessor);
  scriptProcessor.connect(audioContext.destination);

  scriptProcessor.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    
    if (audioBuffer.length === 0) {
      speechStartTimestamp = Date.now();
    }

    // Append current samples to buffer
    for (let i = 0; i < inputData.length; i++) {
      audioBuffer.push(inputData[i]);
    }

    // Check max chunk duration constraint (exactly 1 minute / 60 seconds)
    const durationMs = (audioBuffer.length / SAMPLE_RATE) * 1000;
    
    if (durationMs - lastProgressMs >= 1000) {
      lastProgressMs = durationMs;
      chrome.runtime.sendMessage({
        type: "audio_progress",
        durationMs: durationMs,
        maxMs: MAX_CHUNK_DURATION_MS
      }).catch(()=>{});
    }

    if (durationMs >= MAX_CHUNK_DURATION_MS) {
      console.log("[Offscreen] 1-minute chunk duration reached. Flushing chunk.");
      flushBuffer();
    }
  };

  console.log("[Offscreen] Tab audio capturing started (1-minute chunking mode).");
}

async function stopCapture() {
  console.log("[Offscreen] Stopping tab audio capture...");
  
  if (outputAudio) {
    outputAudio.pause();
    outputAudio.srcObject = null;
    outputAudio = null;
  }

  if (scriptProcessor) {
    scriptProcessor.disconnect();
    scriptProcessor = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    if (audioContext.state !== "closed") {
      await audioContext.close();
    }
    audioContext = null;
  }

  flushBuffer();
  lastProgressMs = 0;
  chrome.runtime.sendMessage({
    type: "audio_progress",
    durationMs: 0,
    maxMs: MAX_CHUNK_DURATION_MS
  }).catch(()=>{});
  console.log("[Offscreen] Tab audio capturing stopped.");
}

function flushBuffer() {
  if (silenceTimer) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  if (audioBuffer.length === 0) {
    isSpeaking = false;
    return;
  }

  const chunkBuffer = [...audioBuffer];
  audioBuffer = [];
  lastProgressMs = 0;
  isSpeaking = false;

  // Convert float samples to 16-bit PCM WAV
  const wavBytes = bufferToWav(chunkBuffer, SAMPLE_RATE);
  const base64Audio = arrayBufferToBase64(wavBytes);

  chrome.runtime.sendMessage({
    type: "audio_chunk",
    audio_base64: base64Audio,
    format: "wav",
    timestamp_ms: speechStartTimestamp || Date.now()
  }).catch((err) => {
    console.error("[Offscreen] Failed to send audio chunk message:", err);
  });
}

// WAV encoding helper
function bufferToWav(buffer, sampleRate) {
  const numOfChan = 1;
  const l = buffer.length;
  const bufferLength = l * 2; // 2 bytes per sample (16-bit PCM)
  const arrayBuffer = new ArrayBuffer(44 + bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Raw PCM
  view.setUint16(22, numOfChan, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // Byte rate (sample rate * block align)
  view.setUint16(32, 2, true); // Block align
  view.setUint16(34, 16, true); // Bits per sample
  writeString(view, 36, "data");
  view.setUint32(40, bufferLength, true);

  let offset = 44;
  for (let i = 0; i < l; i++) {
    const s = Math.max(-1, Math.min(1, buffer[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return arrayBuffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

// ArrayBuffer to Base64 utility
function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
