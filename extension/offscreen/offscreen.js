console.log("[Offscreen] Offscreen script initialized.");

let audioContext = null;
let mediaStream = null;
let scriptProcessor = null;

// VAD parameters
const SAMPLE_RATE = 16000;
const BUFFER_SIZE = 4096;
const RMS_THRESHOLD = 0.015; // Volume threshold to trigger speaking
const SILENCE_TIMEOUT_MS = 1000; // 1 second of silence to split chunk
const MAX_CHUNK_DURATION_MS = 15000; // Force split at 15 seconds to avoid memory issues

let audioBuffer = [];
let isSpeaking = false;
let silenceTimer = null;
let speechStartTimestamp = null;

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
    
    // Calculate volume RMS
    let sum = 0;
    for (let i = 0; i < inputData.length; i++) {
      sum += inputData[i] * inputData[i];
    }
    const rms = Math.sqrt(sum / inputData.length);

    if (rms > RMS_THRESHOLD) {
      if (!isSpeaking) {
        console.log("[Offscreen] Speech detected (start of chunk).");
        isSpeaking = true;
        speechStartTimestamp = Date.now();
      }
      
      // Clear silence timer if speaking continues
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
    }

    if (isSpeaking) {
      // Append current samples to buffer
      for (let i = 0; i < inputData.length; i++) {
        audioBuffer.push(inputData[i]);
      }

      // Check max chunk duration constraint
      const durationMs = (audioBuffer.length / SAMPLE_RATE) * 1000;
      if (durationMs >= MAX_CHUNK_DURATION_MS) {
        console.log("[Offscreen] Max chunk duration reached. Flushing chunk.");
        flushBuffer();
      } else if (rms <= RMS_THRESHOLD && !silenceTimer) {
        // Set silence timer to close the chunk if silence persists
        silenceTimer = setTimeout(() => {
          console.log("[Offscreen] Silence detected. Flushing chunk.");
          flushBuffer();
        }, SILENCE_TIMEOUT_MS);
      }
    }
  };

  console.log("[Offscreen] Tab audio capturing started.");
}

async function stopCapture() {
  console.log("[Offscreen] Stopping tab audio capture...");
  
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
