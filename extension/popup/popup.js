document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".panel");
  const enableAudioCheckbox = document.getElementById("enable-audio");
  const connectionStatus = document.getElementById("connection-status");

  // Tab switching logic
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.add("hidden"));

      tab.classList.add("active");
      const targetId = tab.id.replace("tab-", "") + "-panel";
      document.getElementById(targetId).classList.remove("hidden");
    });
  });

  const enableOverlayCheckbox = document.getElementById("enable-overlay");

  // Load initial checkbox state from chrome storage
  chrome.storage.local.get(["audioCaptureEnabled", "showOverlay"], (result) => {
    if (result.audioCaptureEnabled !== undefined) {
      enableAudioCheckbox.checked = result.audioCaptureEnabled;
    }
    if (result.showOverlay !== undefined) {
      enableOverlayCheckbox.checked = result.showOverlay;
    }
  });

  // Handle setting changes (triggers user gesture for tabCapture)
  enableAudioCheckbox.addEventListener("change", () => {
    const isEnabled = enableAudioCheckbox.checked;
    console.log(`[Popup] Audio capture checkbox toggled to: ${isEnabled}`);
    
    // Save to storage
    chrome.storage.local.set({ audioCaptureEnabled: isEnabled });

    // Send command to service-worker
    chrome.runtime.sendMessage({
      type: "toggle-audio-capture",
      enabled: isEnabled
    }).catch((err) => {
      console.warn("[Popup] Failed to send toggle-audio-capture command:", err.message);
    });
  });

  enableOverlayCheckbox.addEventListener("change", () => {
    const isEnabled = enableOverlayCheckbox.checked;
    console.log(`[Popup] Overlay checkbox toggled to: ${isEnabled}`);
    chrome.storage.local.set({ showOverlay: isEnabled });
  });

  // Query background script connection status
  chrome.runtime.sendMessage({ type: "get-connection-status" }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn("[Popup] Could not connect to background service worker:", chrome.runtime.lastError.message);
      connectionStatus.innerText = "Disconnected";
      connectionStatus.className = "status-pill status-disconnected";
      return;
    }
    if (response && response.connected) {
      connectionStatus.innerText = "Connected";
      connectionStatus.className = "status-pill status-connected";
    } else {
      connectionStatus.innerText = "Disconnected";
      connectionStatus.className = "status-pill status-disconnected";
    }
  });

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "connection-status-update") {
      if (message.connected) {
        connectionStatus.innerText = "Connected";
        connectionStatus.className = "status-pill status-connected";
      } else {
        connectionStatus.innerText = "Disconnected";
        connectionStatus.className = "status-pill status-disconnected";
      }
    }
  });

  console.log("[Popup] Popup loaded successfully.");
});
