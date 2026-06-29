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
    if (area === "local" && changes.showOverlay) {
      toggleOverlayVisibility(changes.showOverlay.newValue);
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
  shadow.appendChild(sidebar);
  
  document.body.appendChild(sidebarContainer);

  // Load initial settings visibility
  chrome.storage.local.get(["showOverlay"], (result) => {
    const show = result.showOverlay !== false; // default to true
    toggleOverlayVisibility(show);
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
        lastCaptionText = text;
        sendCaptionChunk(text);
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

function handleStatusUpdate(data) {
  setupSidebarOverlay();
  if (!shadow) return;
  const sidebar = shadow.getElementById("factcheck-sidebar");
  if (!sidebar) return;

  let card = claimCards.get(data.claim_id);
  if (!card) {
    // Create claim card
    card = document.createElement("div");
    card.className = "claim-card";
    card.id = `card-${data.claim_id}`;
    
    const header = document.createElement("div");
    header.className = "card-header";
    
    const textEl = document.createElement("p");
    textEl.className = "claim-text";
    textEl.innerText = data.claim_text;
    header.appendChild(textEl);
    
    const badge = document.createElement("span");
    badge.className = "status-badge";
    header.appendChild(badge);
    
    card.appendChild(header);
    
    // Insert new card at the top of the sidebar
    sidebar.insertBefore(card, sidebar.firstChild);
    claimCards.set(data.claim_id, card);
    
    // Trigger smooth fade-in
    setTimeout(() => card.classList.add("show"), 50);
  }

  // Update status label
  const badge = card.querySelector(".status-badge");
  if (badge) {
    badge.className = "status-badge";
    badge.innerHTML = "";
    
    const pulseDot = document.createElement("span");
    pulseDot.className = "pulse-dot";
    badge.appendChild(pulseDot);
    
    const label = document.createElement("span");
    label.innerText = data.status;
    badge.appendChild(label);
    
    badge.classList.add(`status-${data.status}`);
  }
}

function handleVerdictUpdate(data) {
  setupSidebarOverlay();
  if (!shadow) return;
  const sidebar = shadow.getElementById("factcheck-sidebar");
  if (!sidebar) return;

  let card = claimCards.get(data.claim_id);
  if (!card) {
    // If cache hit immediately, card might not exist yet
    handleStatusUpdate({
      claim_id: data.claim_id,
      claim_text: data.claim_text,
      status: "checking"
    });
    card = claimCards.get(data.claim_id);
  }

  // Set card classes and status
  card.className = "claim-card show";
  card.classList.add(`verdict-${data.verdict}`);

  const badge = card.querySelector(".status-badge");
  if (badge) {
    badge.className = `status-badge status-${data.verdict}`;
    badge.innerText = data.verdict;
  }

  // Create collapsible card body
  const body = document.createElement("div");
  body.className = "card-body";
  
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "details-toggle";
  toggleBtn.innerText = "View Details";
  body.appendChild(toggleBtn);
  
  const details = document.createElement("div");
  details.className = "collapsed-content";
  
  const explanation = document.createElement("p");
  explanation.className = "explanation-text";
  explanation.innerText = data.explanation;
  details.appendChild(explanation);

  // Sources section
  if (data.sources && data.sources.length > 0) {
    const sourcesContainer = document.createElement("div");
    sourcesContainer.className = "sources-container";
    
    const srcTitle = document.createElement("span");
    srcTitle.className = "sources-title";
    srcTitle.innerText = "Sources";
    sourcesContainer.appendChild(srcTitle);
    
    data.sources.forEach((src) => {
      const link = document.createElement("a");
      link.className = "source-item";
      link.href = src.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.innerText = src.title || src.domain || "Source";
      
      const domainBadge = document.createElement("span");
      domainBadge.className = "source-domain";
      domainBadge.innerText = src.domain || new URL(src.url).hostname;
      link.appendChild(domainBadge);
      
      sourcesContainer.appendChild(link);
    });
    
    details.appendChild(sourcesContainer);
  }

  body.appendChild(details);
  card.appendChild(body);

  // Set Details expanded / collapsed state toggle
  toggleBtn.addEventListener("click", () => {
    const isExpanded = details.classList.contains("show");
    if (isExpanded) {
      details.classList.remove("show");
      toggleBtn.classList.remove("expanded");
    } else {
      details.classList.add("show");
      toggleBtn.classList.add("expanded");
    }
  });

  // Cached status badge indicator
  if (data.cached) {
    const cachedIndicator = document.createElement("span");
    cachedIndicator.className = "cached-indicator";
    cachedIndicator.innerText = "Cached";
    card.appendChild(cachedIndicator);
  }
}

// Receive messages from background script WebSocket relay
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ping") {
    sendResponse({ status: "alive" });
  } else if (message.type === "status_update") {
    handleStatusUpdate(message);
  } else if (message.type === "verdict_update") {
    handleVerdictUpdate(message);
  }
});

// Run init
init();
