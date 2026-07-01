// Signal to background script that the side panel is currently open/active
const port = chrome.runtime.connect({ name: "sidepanel" });

const claimCards = new Map();

// Listen to session restoration messages from background port connection
port.onMessage.addListener((message) => {
  if (message.type === "restore-transcript") {
    const textEl = document.getElementById("live-transcribe-text");
    const box = document.getElementById("live-transcribe");
    if (textEl && box) {
      box.classList.remove("hidden");
      textEl.innerText = message.text;
    }
  } else if (message.type === "restore-claims") {
    // Re-render claims from session cache in order
    message.claims.forEach((claim) => {
      if (claim.type === "status_update") {
        handleStatusUpdate(claim);
      } else if (claim.type === "verdict_update") {
        handleVerdictUpdate(claim);
      }
    });
  }
});

// CRITICAL: Listen to runtime messages synchronously at the top level.
// Registering inside DOMContentLoaded can cause Chrome to drop messages or close ports.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "connection-status-update") {
    const connectionStatus = document.getElementById("connection-status");
    if (connectionStatus) {
      if (message.connected) {
        connectionStatus.innerText = "Connected";
        connectionStatus.className = "status-pill status-connected";
      } else {
        connectionStatus.innerText = "Disconnected";
        connectionStatus.className = "status-pill status-disconnected";
      }
    }
  } else if (message.type === "status_update") {
    handleStatusUpdate(message);
  } else if (message.type === "verdict_update") {
    handleVerdictUpdate(message);
  } else if (message.type === "transcription") {
    handleTranscriptionUpdate(message);
  } else if (message.type === "audio_progress") {
    handleAudioProgress(message);
  }
});

document.addEventListener("DOMContentLoaded", () => {
  const tabs = document.querySelectorAll(".tab-btn");
  const panels = document.querySelectorAll(".panel");
  const enableAudioCheckbox = document.getElementById("enable-audio");
  const powerBtn = document.getElementById("power-toggle-btn");

  function updatePowerBtnUI(isEnabled) {
    if (!powerBtn) return;
    if (isEnabled) {
      powerBtn.classList.remove("power-off");
      powerBtn.classList.add("power-on");
      powerBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>';
    } else {
      powerBtn.classList.remove("power-on");
      powerBtn.classList.add("power-off");
      powerBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>';
    }
  }

  if (powerBtn) {
    powerBtn.addEventListener("click", () => {
      chrome.storage.local.get("audioCaptureEnabled", (result) => {
        const currentlyEnabled = result.audioCaptureEnabled || false;
        const newStatus = !currentlyEnabled;
        chrome.storage.local.set({ audioCaptureEnabled: newStatus });
        chrome.runtime.sendMessage({ type: "toggle-audio-capture", enabled: newStatus });
        updatePowerBtnUI(newStatus);
        if (enableAudioCheckbox) enableAudioCheckbox.checked = newStatus;
      });
    });
  }

  // Listen to external toggles (like clicking the action icon or settings checkbox)
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.audioCaptureEnabled) {
      updatePowerBtnUI(changes.audioCaptureEnabled.newValue);
    }
  });

  // Tab switching logic
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      panels.forEach((p) => p.classList.add("hidden"));

      tab.classList.add("active");
      const targetId = tab.id.replace("tab-", "") + "-panel";
      const panel = document.getElementById(targetId);
      if (panel) panel.classList.remove("hidden");
    });
  });

  const enableOverlayCheckbox = document.getElementById("enable-overlay");

  // Load initial checkbox state from chrome storage
  chrome.storage.local.get(["audioCaptureEnabled", "showOverlay"], (result) => {
    if (result.audioCaptureEnabled !== undefined) {
      if (enableAudioCheckbox) enableAudioCheckbox.checked = result.audioCaptureEnabled;
      updatePowerBtnUI(result.audioCaptureEnabled);
    }
    if (result.showOverlay !== undefined) {
      enableOverlayCheckbox.checked = result.showOverlay;
    }
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
      return;
    }
  });

  console.log("[Popup] Popup loaded successfully.");
});

// Helper functions for rendering claims & transcription inside Side Panel
function setCardState(card, pill, state) {
  const states = ["checking", "researching", "debating", "supported", "contradicted", "mixed", "unverifiable"];
  states.forEach((s) => {
    card.classList.remove(`claim-card--${s}`);
    pill.classList.remove(`status-pill--${s}`);
  });
  card.classList.add(`claim-card--${state}`);
  pill.classList.add(`status-pill--${state}`);
}

function createClaimCard(data) {
  const card = document.createElement("div");
  card.className = "claim-card";
  card.id = `card-${data.claim_id}`;

  const accent = document.createElement("div");
  accent.className = "claim-card__accent";
  card.appendChild(accent);

  const header = document.createElement("div");
  header.className = "claim-card__header";

  const pill = document.createElement("span");
  pill.className = "status-pill";
  header.appendChild(pill);

  const headerRight = document.createElement("div");
  headerRight.className = "claim-card__header-right";

  const timestamp = document.createElement("span");
  timestamp.className = "claim-card__timestamp";
  timestamp.innerText = "Just now";
  headerRight.appendChild(timestamp);

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "claim-card__close-btn";
  closeBtn.innerHTML = "&times;";
  closeBtn.title = "Dismiss";
  closeBtn.setAttribute("aria-label", "Dismiss alert");
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    card.classList.remove("show");
    setTimeout(() => {
      card.remove();
      claimCards.delete(data.claim_id);
    }, 300);
  });
  headerRight.appendChild(closeBtn);

  header.appendChild(headerRight);
  card.appendChild(header);

  const textEl = document.createElement("p");
  textEl.className = "claim-card__text";
  textEl.innerText = data.claim_text;
  card.appendChild(textEl);

  return card;
}

function handleStatusUpdate(data) {
  const container = document.getElementById("active-claims");
  if (!container) return;

  let card = claimCards.get(data.claim_id);
  if (!card) {
    card = createClaimCard(data);
    container.insertBefore(card, container.firstChild);
    claimCards.set(data.claim_id, card);
    setTimeout(() => card.classList.add("show"), 50);
  }

  const pill = card.querySelector(".status-pill");
  if (pill) {
    setCardState(card, pill, data.status);
    pill.innerHTML = "";

    const pulseDot = document.createElement("span");
    pulseDot.className = "pulse-dot";
    pill.appendChild(pulseDot);

    const label = document.createElement("span");
    label.innerText = data.status;
    pill.appendChild(label);
  }
}

function handleVerdictUpdate(data) {
  const activeContainer = document.getElementById("active-claims");
  const prevContainer = document.getElementById("previous-claims");
  if (!prevContainer) return;

  let card = claimCards.get(data.claim_id);
  if (!card) {
    handleStatusUpdate({
      claim_id: data.claim_id,
      claim_text: data.claim_text,
      status: "checking"
    });
    card = claimCards.get(data.claim_id);
  }

  if (card.parentNode !== prevContainer) {
    prevContainer.insertBefore(card, prevContainer.firstChild);
  }

  card.querySelectorAll(".claim-card__details, .claim-card__expand, .claim-card__cached").forEach((el) => el.remove());

  const pill = card.querySelector(".status-pill");
  if (pill) {
    setCardState(card, pill, data.verdict);
    pill.innerHTML = "";
    const label = document.createElement("span");
    label.innerText = data.verdict;
    pill.appendChild(label);
  }

  const details = document.createElement("div");
  details.className = "claim-card__details";

  const explanation = document.createElement("p");
  explanation.className = "claim-card__explanation";
  explanation.innerText = data.explanation;
  details.appendChild(explanation);

  if (data.sources && data.sources.length > 0) {
    const sourcesTitle = document.createElement("span");
    sourcesTitle.className = "claim-card__sources-title";
    sourcesTitle.innerText = "Sources";
    details.appendChild(sourcesTitle);

    const sourcesList = document.createElement("ul");
    sourcesList.className = "claim-card__sources";

    data.sources.forEach((src) => {
      const li = document.createElement("li");
      li.className = "claim-card__source";

      const link = document.createElement("a");
      link.className = "source-item";
      link.href = src.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("data-url", src.url);

      const iconWrap = document.createElement("span");
      iconWrap.innerHTML =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
        '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
      link.appendChild(iconWrap);

      const name = document.createElement("span");
      name.className = "source-name";
      name.innerText = src.title || src.domain || "Source";
      link.appendChild(name);

      const domainBadge = document.createElement("span");
      domainBadge.className = "source-domain";
      domainBadge.innerText = src.domain || "";
      link.appendChild(domainBadge);

      li.appendChild(link);
      sourcesList.appendChild(li);
    });

    details.appendChild(sourcesList);
    addSourcesToTab(data.sources);
  }

  card.appendChild(details);

  const expandBtn = document.createElement("button");
  expandBtn.type = "button";
  expandBtn.className = "claim-card__expand";
  expandBtn.innerText = "View Details";
  expandBtn.setAttribute("aria-expanded", "false");
  card.appendChild(expandBtn);

  expandBtn.addEventListener("click", () => {
    const open = details.classList.toggle("show");
    expandBtn.classList.toggle("expanded", open);
    expandBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });

  if (data.cached) {
    const cachedTag = document.createElement("span");
    cachedTag.className = "claim-card__cached";
    cachedTag.innerText = "Cached";
    card.appendChild(cachedTag);
  }
}

function addSourcesToTab(sources) {
  const container = document.getElementById("sources-list-container");
  if (!container) return;

  const placeholder = container.querySelector(".placeholder-text");
  if (placeholder) {
    placeholder.remove();
  }

  sources.forEach((src) => {
    if (container.querySelector(`[data-url="${src.url.replace(/"/g, '&quot;')}"]`)) return;

    const sourceEl = document.createElement("div");
    sourceEl.className = "global-source-item";

    const link = document.createElement("a");
    link.className = "source-item";
    link.href = src.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.setAttribute("data-url", src.url);

    const iconWrap = document.createElement("span");
    iconWrap.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>' +
      '<path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    link.appendChild(iconWrap);

    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = src.title || src.domain || "Source";
    link.appendChild(name);

    const domainBadge = document.createElement("span");
    domainBadge.className = "source-domain";
    domainBadge.textContent = src.domain || "";
    link.appendChild(domainBadge);

    sourceEl.appendChild(link);
    container.appendChild(sourceEl);
  });
}

function handleTranscriptionUpdate(data) {
  const box = document.getElementById("live-transcribe");
  const textEl = document.getElementById("live-transcribe-text");
  if (box && textEl) {
    box.classList.remove("hidden");
    const currentText = textEl.innerText === "Waiting for audio..." ? "" : textEl.innerText;
    const newText = (currentText + " " + data.text).trim();
    textEl.innerText = newText.slice(-250);
  }
}

function handleAudioProgress(data) {
  const timerEl = document.getElementById("recording-timer");
  if (!timerEl) return;
  
  if (data.durationMs === 0) {
     timerEl.style.display = "none";
  } else {
     timerEl.style.display = "block";
     const timeLeft = Math.max(0, Math.ceil((data.maxMs - data.durationMs) / 1000));
     timerEl.innerText = `Recording audio... Sending chunk in ${timeLeft}s`;
  }
}
