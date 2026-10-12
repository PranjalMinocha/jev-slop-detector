const statusElement = document.querySelector("#status");
const metricsElement = document.querySelector("#metrics");
const detailElement = document.querySelector("#detail");
const rescanButton = document.querySelector("#rescan");
const versionElement = document.querySelector("#version");
const extractionsElement = document.querySelector("#extractions");
const extractionListElement = document.querySelector("#extraction-list");
const apiKeyForm = document.querySelector("#api-key-form");
const apiKeyInput = document.querySelector("#api-key");
const apiModeElement = document.querySelector("#api-mode");
const useMockButton = document.querySelector("#use-mock");

let activeTabId = null;

function setStatus(kind, message) {
  statusElement.className = `status ${kind}`;
  statusElement.textContent = message;
}

function setMetric(id, value) {
  document.querySelector(`#${id}`).textContent = String(value ?? 0);
}

function renderExtractions(extractions) {
  extractionListElement.replaceChildren();
  const posts = Array.isArray(extractions) ? extractions : [];
  extractionsElement.hidden = posts.length === 0;
  posts.forEach((post, index) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `Post ${index + 1} · ${post.textLength} characters`;
    const text = document.createElement("pre");
    text.textContent = post.text;
    details.append(summary, text);
    extractionListElement.append(details);
  });
}

async function refreshApiSettings(message = "") {
  const { jevSettings = {} } = await chrome.storage.local.get("jevSettings");
  const hasKey = typeof jevSettings.authToken === "string" && jevSettings.authToken.trim().length > 0;
  const jevEnabled = hasKey && jevSettings.mockMode !== true;
  apiModeElement.className = `api-mode ${jevEnabled ? "enabled" : "mock"}`;
  apiModeElement.textContent = message || (jevEnabled
    ? "Real Jev enabled · jev-latest"
    : "Mock fallback active · add a key to enable Jev");
  apiKeyInput.placeholder = hasKey ? "Key saved — enter a replacement" : "Paste your API key";
  useMockButton.hidden = !hasKey;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function getDiagnostics() {
  const tab = await getActiveTab();
  activeTabId = tab?.id ?? null;
  if (!activeTabId) throw new Error("No active browser tab was found.");
  return chrome.tabs.sendMessage(activeTabId, { type: "JEV_GET_DIAGNOSTICS" });
}

function render(response) {
  const data = response?.diagnostics;
  if (!response?.ok || !data) throw new Error("The content script did not return diagnostics.");

  versionElement.textContent = `Version ${data.version}`;
  metricsElement.hidden = false;
  rescanButton.hidden = false;
  setMetric("candidates", data.candidatesFound);
  setMetric("observed", data.observed);
  setMetric("classified", data.classified);
  setMetric("badges", data.badges);
  setMetric("skipped", data.skipped);
  setMetric("errors", data.errors);
  renderExtractions(data.extractedPosts);

  if (!data.started) {
    setStatus("loading", "Waiting for LinkedIn to finish loading…");
    detailElement.textContent = "Try again in a moment.";
  } else if (data.errors > 0) {
    setStatus("error", "Classification error");
    detailElement.textContent = data.lastError || "Open the service-worker console for details.";
  } else if (data.candidatesFound === 0) {
    setStatus("warning", "No LinkedIn posts recognized");
    detailElement.textContent = "Open the LinkedIn home feed, then press Rescan page.";
  } else if (data.classified === 0) {
    setStatus("loading", "Posts found; waiting for visibility…");
    detailElement.textContent = "Scroll the feed slightly to trigger classification.";
  } else {
    setStatus("success", "Working on this page");
    const source = data.classificationSource === "jev" ? "Jev" : "mock";
    detailElement.textContent = `${data.visibleBadges} score badge(s) are visible · ${source} scoring.`;
  }
}

async function refresh() {
  try {
    render(await getDiagnostics());
  } catch (error) {
    setStatus("error", "Not connected to this tab");
    metricsElement.hidden = true;
    extractionsElement.hidden = true;
    rescanButton.hidden = true;
    detailElement.textContent = "Open linkedin.com, reload the page once, then reopen this panel.";
    console.warn("[Jev Slop Detector] Popup diagnostics failed:", error);
  }
}

rescanButton.addEventListener("click", async () => {
  if (!activeTabId) return;
  rescanButton.disabled = true;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: "JEV_RESCAN" });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await refresh();
  } finally {
    rescanButton.disabled = false;
  }
});

apiKeyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const authToken = apiKeyInput.value.trim();
  if (!authToken) {
    apiModeElement.className = "api-mode error";
    apiModeElement.textContent = "Enter an API key before saving.";
    return;
  }

  const saveButton = document.querySelector("#save-key");
  saveButton.disabled = true;
  try {
    await chrome.storage.local.set({ jevSettings: { authToken, mockMode: false } });
    apiKeyInput.value = "";
    await refreshApiSettings("Real Jev enabled · refresh LinkedIn to classify with Jev");
  } finally {
    saveButton.disabled = false;
  }
});

useMockButton.addEventListener("click", async () => {
  useMockButton.disabled = true;
  try {
    await chrome.storage.local.set({ jevSettings: { mockMode: true } });
    apiKeyInput.value = "";
    await refreshApiSettings("Mock fallback enabled · saved API key removed");
  } finally {
    useMockButton.disabled = false;
  }
});

void refreshApiSettings();
void refresh();
