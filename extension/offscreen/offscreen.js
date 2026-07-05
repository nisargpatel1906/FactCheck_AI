console.log("[Offscreen] Offscreen script initialized.");

// Signal to background worker that the offscreen document is loaded and ready
chrome.runtime.sendMessage({ type: "offscreen-ready" }).catch(() => {});

let audioContext = null;
let mediaStream = null;
let outputAudio = null;
let recorderNode = null;  // AudioWorkletNode replacing ScriptProcessorNode

// VAD parameters
const SAMPLE_RATE = 16000;
const MAX_CHUNK_DURATION_MS = 15000; // 15 seconds — fast first transcription
const SPEECH_RMS_THRESHOLD = 0.01;  // discard silent frames

let audioBuffer = [];
let speechStartTimestamp = null;
let lastProgressMs = 0;
let chunkHasSpeech = false;
let isPaused = false;

// Listen for messages from background service worker
chrome.runtime.onMessage.addListener(async (message) => {
  console.log("[Offscreen] Received message:", message.type);
  if (message.type === "start-capture") {
    try {
      if (audioContext) await stopCapture();
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

// Inline AudioWorklet processor registered at runtime (no separate file needed)
const WORKLET_CODE = `
class ChunkProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0][0];
    if (ch && ch.length > 0) {
      this.port.postMessage(ch);
    }
    return true;
  }
}
registerProcessor('chunk-processor', ChunkProcessor);
`;

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

  audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

  // Register inline worklet (blob URL avoids needing a separate .js file)
  const blob = new Blob([WORKLET_CODE], { type: "application/javascript" });
  const blobUrl = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  const source = audioContext.createMediaStreamSource(mediaStream);
  recorderNode = new AudioWorkletNode(audioContext, "chunk-processor");

  recorderNode.port.onmessage = (event) => {
    if (isPaused) return;
    const inputData = event.data; // Float32Array

    if (audioBuffer.length === 0) {
      speechStartTimestamp = Date.now();
    }

    // Append samples
    for (let i = 0; i < inputData.length; i++) {
      audioBuffer.push(inputData[i]);
    }

    // VAD: check RMS for speech
    if (!chunkHasSpeech) {
      let sumSq = 0;
      for (let i = 0; i < inputData.length; i++) sumSq += inputData[i] * inputData[i];
      if (Math.sqrt(sumSq / inputData.length) >= SPEECH_RMS_THRESHOLD) {
        chunkHasSpeech = true;
      }
    }

    // Progress & chunk flush
    const durationMs = (audioBuffer.length / SAMPLE_RATE) * 1000;

    if (durationMs - lastProgressMs >= 1000) {
      lastProgressMs = durationMs;
      chrome.runtime.sendMessage({
        type: "audio_progress",
        durationMs,
        maxMs: MAX_CHUNK_DURATION_MS
      }).catch(() => {});
    }

    if (durationMs >= MAX_CHUNK_DURATION_MS) {
      console.log("[Offscreen] Chunk limit reached. Flushing.");
      flushBuffer();
    }
  };

  source.connect(recorderNode);
  // Don't connect recorderNode to destination — we don't want double audio
  // (outputAudio already handles playback)

  console.log("[Offscreen] Audio capture started (AudioWorklet, 15s chunks).");
}

async function stopCapture() {
  console.log("[Offscreen] Stopping capture...");

  if (outputAudio) {
    outputAudio.pause();
    outputAudio.srcObject = null;
    outputAudio = null;
  }

  if (recorderNode) {
    recorderNode.port.onmessage = null;
    recorderNode.disconnect();
    recorderNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  if (audioContext) {
    if (audioContext.state !== "closed") await audioContext.close();
    audioContext = null;
  }

  flushBuffer();
  lastProgressMs = 0;
  chrome.runtime.sendMessage({ type: "audio_progress", durationMs: 0, maxMs: MAX_CHUNK_DURATION_MS }).catch(() => {});
  console.log("[Offscreen] Audio capture stopped.");
}

function flushBuffer() {
  if (audioBuffer.length === 0) return;

  const hadSpeech = chunkHasSpeech;
  const chunkBuffer = [...audioBuffer];
  audioBuffer = [];
  lastProgressMs = 0;
  chunkHasSpeech = false;

  if (!hadSpeech) {
    console.log("[Offscreen] Chunk discarded: silent.");
    return;
  }

  const wavBytes = bufferToWav(chunkBuffer, SAMPLE_RATE);
  const base64Audio = arrayBufferToBase64(wavBytes);

  chrome.runtime.sendMessage({
    type: "audio_chunk",
    audio_base64: base64Audio,
    format: "wav",
    timestamp_ms: speechStartTimestamp || Date.now()
  }).catch(err => console.error("[Offscreen] Failed to send audio chunk:", err));
}

function bufferToWav(buffer, sampleRate) {
  const l = buffer.length;
  const bufferLength = l * 2;
  const arrayBuffer = new ArrayBuffer(44 + bufferLength);
  const view = new DataView(arrayBuffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + bufferLength, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
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

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
