let lastCaptionText = "";
let captionObserver = null;
let activeVideoElement = null;

let sidebarContainer = null;
let shadow = null;
const claimCards = new Map();

// Initialize caption detection and sidebar overlay
function init() {
  console.log("[Content Script] Initializing caption detection...");
  checkForVideoAndSetup();

  // Watch for DOM changes (especially important for SPA site navigation like YouTube)
  const navObserver = new MutationObserver(() => {
    checkForVideoAndSetup();
  });
  navObserver.observe(document.body, { childList: true, subtree: true });

  // Initialize shadow-dom overlay sidebar
  setupSidebarOverlay();

  // Listen to chrome storage changes to toggle overlay on/off dynamically
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") {
      if (changes.showOverlay) {
        toggleOverlayVisibility(changes.showOverlay.newValue);
        const enableOverlayCheckbox = shadow ? shadow.getElementById("enable-overlay-overlay") : null;
        if (enableOverlayCheckbox) enableOverlayCheckbox.checked = changes.showOverlay.newValue;
      }
      if (changes.audioCaptureEnabled) {
        const enableAudioCheckbox = shadow ? shadow.getElementById("enable-audio-overlay") : null;
        if (enableAudioCheckbox) enableAudioCheckbox.checked = changes.audioCaptureEnabled.newValue;
      }
    }
  });
}

function setupSidebarOverlay() {
  if (sidebarContainer) return;

  console.log("[Content Script] Setting up Shadow DOM Sidebar overlay...");
  sidebarContainer = document.createElement("div");
  sidebarContainer.id = "factcheck-ai-shadow-host";
  
  shadow = sidebarContainer.attachShadow({ mode: "open" });
  
  // Link overlay.css stylesheet into Shadow DOM
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content/overlay.css");
  shadow.appendChild(link);
  
  // Create sidebar panel inside Shadow DOM
  const sidebar = document.createElement("div");
  sidebar.id = "factcheck-sidebar";
  sidebar.className = "sidebar-container";
  sidebar.style.display = "none"; // Hide by default until storage check resolves
  
  // Left Nav (Mockup layout)
  const sidebarNav = document.createElement("div");
  sidebarNav.className = "sidebar-nav";
  
  const btnFeed = document.createElement("button");
  btnFeed.className = "nav-btn active";
  btnFeed.id = "nav-feed";
  btnFeed.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
    <span>Feed</span>
  `;
  
  const btnSources = document.createElement("button");
  btnSources.className = "nav-btn";
  btnSources.id = "nav-sources";
  btnSources.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
    <span>Sources</span>
  `;
  
  const btnSettings = document.createElement("button");
  btnSettings.className = "nav-btn";
  btnSettings.id = "nav-settings";
  btnSettings.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    <span>Settings</span>
  `;
  
  sidebarNav.appendChild(btnFeed);
  sidebarNav.appendChild(btnSources);
  sidebarNav.appendChild(btnSettings);
  sidebar.appendChild(sidebarNav);
  
  // Right Content Wrapper
  const content = document.createElement("div");
  content.className = "sidebar-content";
  
  const header = document.createElement("header");
  header.className = "sidebar-header";
  header.innerHTML = `
    <span class="brand-title">FactCheck AI</span>
    <div class="header-actions">
      <button class="hamburger-btn" title="Menu">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
      <button class="power-btn" title="Shutdown" id="power-shutdown-btn">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
      </button>
    </div>
  `;
  content.appendChild(header);
  
  // Content Tabs
  const contentBody = document.createElement("div");
  contentBody.className = "content-body";
  
  // 1. Feed Panel
  const panelFeed = document.createElement("div");
  panelFeed.id = "panel-feed";
  panelFeed.className = "panel-tab";
  panelFeed.innerHTML = `
    <div class="live-monitor-header">
      <span class="monitor-title">Live Monitor - Scanning</span>
      <span class="active-pill"><span class="active-pill__dot"></span>Active</span>
    </div>
    <p class="monitor-subtitle">Scanning active tab</p>
    
    <div class="live-transcribe-box hidden" id="live-transcribe">
      <div class="transcribe-title">LIVE TRANSCRIPT</div>
      <div class="transcribe-text" id="live-transcribe-text"></div>
    </div>
    
    <div class="claims-section-title">ACTIVE CLAIMS</div>
    <div class="claims-list" id="active-claims"></div>
    
    <div class="section-title">PREVIOUS RESULTS</div>
    <div class="claims-list" id="previous-claims"></div>
  `;
  contentBody.appendChild(panelFeed);
  
  // 2. Sources Panel
  const panelSources = document.createElement("div");
  panelSources.id = "panel-sources";
  panelSources.className = "panel-tab hidden";
  panelSources.innerHTML = `
    <div class="live-monitor-header">
      <span class="monitor-title">Sources</span>
    </div>
    <div class="sources-list" id="sources-list-container">
      <p class="placeholder-text">Sources from verified claims will appear here.</p>
    </div>
  `;
  contentBody.appendChild(panelSources);
  
  // 3. Settings Panel
  const panelSettings = document.createElement("div");
  panelSettings.id = "panel-settings";
  panelSettings.className = "panel-tab hidden";
  panelSettings.innerHTML = `
    <div class="live-monitor-header">
      <span class="monitor-title">Settings</span>
    </div>
    <div class="settings-container">
      <div class="setting-item" style="flex-direction: column; align-items: flex-start; gap: 4px;">
        <div style="display: flex; justify-content: space-between; width: 100%; align-items: center;">
          <label for="enable-audio-overlay">Listen to tab's audio</label>
          <input type="checkbox" id="enable-audio-overlay" disabled>
        </div>
        <div style="font-size: 11px; color: #a0a0a0; line-height: 1.3; margin-top: 4px;">To start or stop audio capture, click the FactCheck AI extension icon in your Chrome toolbar.</div>
      </div>
      <div class="setting-item">
        <label for="enable-overlay-overlay">Show FactCheck Overlay</label>
        <input type="checkbox" id="enable-overlay-overlay" checked>
      </div>
    </div>
  `;
  contentBody.appendChild(panelSettings);
  
  content.appendChild(contentBody);
  sidebar.appendChild(content);
  shadow.appendChild(sidebar);
  
  document.body.appendChild(sidebarContainer);
  
  // Tab interactions
  const tabs = [btnFeed, btnSources, btnSettings];
  const panels = [panelFeed, panelSources, panelSettings];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      panels.forEach(p => p.classList.add("hidden"));
      tab.classList.add("active");
      panels[index].classList.remove("hidden");
    });
  });
  
  // Shutdown Power Button
  const powerBtn = shadow.getElementById("power-shutdown-btn");
  powerBtn.addEventListener("click", () => {
    toggleOverlayVisibility(false);
    chrome.storage.local.set({ showOverlay: false });
  });
  
  // Settings checkbox listeners
  const enableAudioCheckbox = shadow.getElementById("enable-audio-overlay");
  const enableOverlayCheckbox = shadow.getElementById("enable-overlay-overlay");
  
  chrome.storage.local.get(["audioCaptureEnabled", "showOverlay"], (result) => {
    if (result.audioCaptureEnabled !== undefined) {
      enableAudioCheckbox.checked = result.audioCaptureEnabled;
    }
    
    // Default to false if not yet set
    const shouldShow = result.showOverlay === true;
    enableOverlayCheckbox.checked = shouldShow;
    toggleOverlayVisibility(shouldShow);
  });
  

  
  enableOverlayCheckbox.addEventListener("change", () => {
    const isEnabled = enableOverlayCheckbox.checked;
    chrome.storage.local.set({ showOverlay: isEnabled });
    toggleOverlayVisibility(isEnabled);
  });
}

function toggleOverlayVisibility(visible) {
  if (!shadow) return;
  const sidebar = shadow.getElementById("factcheck-sidebar");
  if (sidebar) {
    sidebar.style.display = visible ? "flex" : "none";
    console.log(`[Content Script] Overlay visibility toggled to: ${visible}`);
  }
}

function checkForVideoAndSetup() {
  const video = document.querySelector("video");
  
  if (video && video !== activeVideoElement) {
    console.log("[Content Script] New video element detected.");
    activeVideoElement = video;
    
    // Clear old observer
    if (captionObserver) {
      captionObserver.disconnect();
      captionObserver = null;
    }
    
    setupYouTubeCaptions();
    setupNativeCaptions(video);
  }
}

// Observe YouTube custom captions
function setupYouTubeCaptions() {
  const captionWindowContainer = document.querySelector(".ytp-caption-window-container");
  if (!captionWindowContainer) {
    // Retry in 1 second if on YouTube
    if (window.location.hostname.includes("youtube.com")) {
      setTimeout(setupYouTubeCaptions, 1000);
    }
    return;
  }

  console.log("[Content Script] Setting up MutationObserver for YouTube captions...");
  
  captionObserver = new MutationObserver(() => {
    const segments = document.querySelectorAll(".ytp-caption-segment");
    if (segments.length > 0) {
      const text = Array.from(segments)
        .map(s => s.innerText.trim())
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
        
      if (text && text !== lastCaptionText) {
        let textToSend = text;
        // If the new caption is just appending words to the previous one, only send the new words
        if (lastCaptionText && text.startsWith(lastCaptionText)) {
          textToSend = text.substring(lastCaptionText.length).trim();
        }
        
        lastCaptionText = text;
        if (textToSend) {
          sendCaptionChunk(textToSend);
        }
      }
    }
  });

  captionObserver.observe(captionWindowContainer, { childList: true, subtree: true });
}

// Observe standard HTML5 video track cues
function setupNativeCaptions(video) {
  if (!video || !video.textTracks) return;

  console.log("[Content Script] Setting up listeners for native HTML5 video tracks...");
  
  Array.from(video.textTracks).forEach((track) => {
    // If the track is disabled, set to hidden so cues are populated but not shown by browser twice
    if (track.mode === "disabled") {
      track.mode = "hidden";
    }

    track.addEventListener("cuechange", () => {
      const activeCues = track.activeCues;
      if (activeCues && activeCues.length > 0) {
        const text = Array.from(activeCues)
          .map(cue => cue.text.trim())
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
          
        if (text && text !== lastCaptionText) {
          lastCaptionText = text;
          sendCaptionChunk(text);
        }
      }
    });
  });
}

function sendCaptionChunk(text) {
  console.log("[Content Script] Caption detected:", text);
  chrome.runtime.sendMessage({
    type: "caption_chunk",
    text: text,
    timestamp_ms: Date.now()
  }).catch(err => {
    // Suppress errors when background script is temporarily sleeping or reloading
  });
}

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
  setupSidebarOverlay();
  if (!shadow) return;
  const container = shadow.getElementById("active-claims");
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
  setupSidebarOverlay();
  if (!shadow) return;
  const activeContainer = shadow.getElementById("active-claims");
  const prevContainer = shadow.getElementById("previous-claims");
  if (!prevContainer) return;

  let card = claimCards.get(data.claim_id);
  if (!card) {
    // Cache hit — card may not exist yet
    handleStatusUpdate({
      claim_id: data.claim_id,
      claim_text: data.claim_text,
      status: "checking"
    });
    card = claimCards.get(data.claim_id);
  }

  // Move card from active to previous results
  if (card.parentNode !== prevContainer) {
    prevContainer.insertBefore(card, prevContainer.firstChild);
  }

  // Remove any existing details / expand / cached elements before re-rendering
  card.querySelectorAll(".claim-card__details, .claim-card__expand, .claim-card__cached").forEach((el) => el.remove());

  const pill = card.querySelector(".status-pill");
  if (pill) {
    setCardState(card, pill, data.verdict);
    pill.innerHTML = "";
    const label = document.createElement("span");
    label.innerText = data.verdict;
    pill.appendChild(label);
  }

  // Collapsible details: explanation + sources
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

      const iconWrap = document.createElement("span");
      iconWrap.className = "source-favicon";
      iconWrap.setAttribute("aria-hidden", "true");
      iconWrap.innerHTML =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
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

    // Also append sources to the global "Sources" tab
    addSourcesToTab(data.sources);
  }

  card.appendChild(details);

  // Expand toggle (ghost button per BRAND_GUIDE §6.3)
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
  if (!shadow) return;
  const container = shadow.getElementById("sources-list-container");
  if (!container) return;

  // Clear placeholder text if it's there
  const placeholder = container.querySelector(".placeholder-text");
  if (placeholder) {
    placeholder.remove();
  }

  sources.forEach((src) => {
    // Avoid duplicates
    if (container.querySelector(`a[href="${src.url}"]`)) return;

    const sourceEl = document.createElement("div");
    sourceEl.className = "global-source-item";
    sourceEl.innerHTML = `
      <a class="source-item" href="${src.url}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
        </svg>
        <span class="source-name">${src.title || src.domain || "Source"}</span>
        <span class="source-domain">${src.domain || ""}</span>
      </a>
    `;
    container.appendChild(sourceEl);
  });
}

function handleTranscriptionUpdate(data) {
  setupSidebarOverlay();
  if (!shadow) return;
  const box = shadow.getElementById("live-transcribe");
  const textEl = shadow.getElementById("live-transcribe-text");
  if (box && textEl) {
    box.classList.remove("hidden");
    const currentText = textEl.innerText === "Waiting for audio..." ? "" : textEl.innerText;
    // Append and keep only the last ~250 chars of transcribed text
    const newText = (currentText + " " + data.text).trim();
    textEl.innerText = newText.slice(-250);
  }
}

// Receive messages from background script WebSocket relay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ status: "alive" });
  } else if (message.type === "toggle-overlay") {
    chrome.storage.local.get(["showOverlay"], (result) => {
      const current = result.showOverlay !== false;
      chrome.storage.local.set({ showOverlay: !current });
      toggleOverlayVisibility(!current);
    });
  } else if (message.type === "set-overlay-visible") {
    toggleOverlayVisibility(message.visible);
  } else if (message.type === "status_update") {
    handleStatusUpdate(message);
  } else if (message.type === "verdict_update") {
    handleVerdictUpdate(message);
  } else if (message.type === "transcription") {
    handleTranscriptionUpdate(message);
  }
});

// Run init
init();
